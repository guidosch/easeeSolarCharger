#!/usr/bin/env python3
"""Spike O4 — does dynamicChargerCurrent expire on a watchdog timer?

The Easee documentation is silent. It matters because of the write budget: if the value
decays on its own, every cycle must rewrite every active charger instead of only those whose
setpoint moved by more than the +/-1 A deadband. That changes both the R8 Firestore write
budget and the R5 Easee 20-writes/minute budget, and it makes the deadband in
packages/core/src/surplus.ts a bug rather than an optimization.

Method: write a setpoint once, then poll observation 48 (dynamicChargerCurrent) alongside
109 (chargerOpMode) for several hours WITHOUT rewriting it. If 48 drops to 0 or to the
charger default while 109 is unchanged, a watchdog exists. Holding 109 constant is what
separates a watchdog from the documented plug-in reset (research R5).

Run against the OWNER'S OWN parking lot only, per the constitution's hardware rule. Leave a
car plugged in but do not touch the cable for the duration.

Usage:
    EASEE_USERNAME=... EASEE_PASSWORD=... EASEE_CHARGER_ID=EH... EASEE_SERIAL=... \
    python3 scripts/spikes/o4_dynamic_current_watchdog.py --amps 6 --hours 6 --interval 5

Writes a CSV trace to fixtures/spikes/o4-watchdog-<serial>.csv.
"""
import argparse
import csv
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

BASE = "https://api.easee.com"
TIMEOUT = 20
OBS_OP_MODE, OBS_DYNAMIC_CURRENT, OBS_OUTPUT_CURRENT = 109, 48, 114


def call(url, token=None, data=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            "Accept": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def observations(token, serial):
    ids = f"{OBS_OP_MODE},{OBS_DYNAMIC_CURRENT},{OBS_OUTPUT_CURRENT}"
    data = call(f"{BASE}/api/state/{serial}/observations?ids={ids}", token=token)
    out = {}
    # Tolerate either a list of {id,value} or a dict keyed by id — the shape is unconfirmed,
    # which is itself part of what this spike establishes.
    if isinstance(data, list):
        for item in data:
            out[int(item.get("id", -1))] = item.get("value")
    elif isinstance(data, dict):
        for k, v in data.items():
            try:
                out[int(k)] = v.get("value") if isinstance(v, dict) else v
            except (ValueError, TypeError):
                pass
    else:
        print(f"  !! unexpected observations shape: {type(data)} {str(data)[:200]}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--amps", type=float, default=6.0, help="setpoint to write once")
    ap.add_argument("--hours", type=float, default=6.0)
    ap.add_argument("--interval", type=float, default=5.0, help="poll minutes")
    ap.add_argument("--no-write", action="store_true", help="observe only, write nothing")
    args = ap.parse_args()

    user, pw = os.environ.get("EASEE_USERNAME"), os.environ.get("EASEE_PASSWORD")
    charger, serial = os.environ.get("EASEE_CHARGER_ID"), os.environ.get("EASEE_SERIAL")
    if not all([user, pw, charger, serial]):
        sys.exit("set EASEE_USERNAME, EASEE_PASSWORD, EASEE_CHARGER_ID, EASEE_SERIAL")

    token = call(f"{BASE}/api/accounts/login", data={"userName": user, "password": pw})["accessToken"]
    print(f"authenticated; charger={charger} serial={serial}")

    if not args.no_write:
        call(f"{BASE}/api/chargers/{charger}/settings",
             token=token, data={"dynamicChargerCurrent": args.amps})
        print(f"wrote dynamicChargerCurrent={args.amps} A once; will NOT rewrite it")
        time.sleep(20)  # let the charger apply and report the new value

    out = pathlib.Path(f"fixtures/spikes/o4-watchdog-{serial}.csv")
    out.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + args.hours * 3600
    baseline_dyn = baseline_op = None
    verdict = "no decay observed"

    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["observedAt", "opMode", "dynamicChargerCurrentA", "outputCurrentA", "note"])
        while time.time() < deadline:
            now = datetime.now(timezone.utc).isoformat()
            try:
                obs = observations(token, serial)
            except urllib.error.HTTPError as e:
                if e.code == 401:  # 1 h token lifetime; this spike outlives it
                    token = call(f"{BASE}/api/accounts/login",
                                 data={"userName": user, "password": pw})["accessToken"]
                    print("  re-authenticated")
                    continue
                print(f"  HTTP {e.code}; retrying next interval")
                time.sleep(args.interval * 60)
                continue

            op, dyn = obs.get(OBS_OP_MODE), obs.get(OBS_DYNAMIC_CURRENT)
            outc = obs.get(OBS_OUTPUT_CURRENT)
            note = ""
            if baseline_dyn is None:
                baseline_dyn, baseline_op = dyn, op
                note = "baseline"
            elif dyn != baseline_dyn:
                if op != baseline_op:
                    note = f"CHANGED but opMode moved {baseline_op}->{op} (plug-in reset, R5)"
                else:
                    note = f"DECAYED {baseline_dyn}->{dyn} with opMode UNCHANGED -> WATCHDOG"
                    verdict = note
            print(f"{now}  opMode={op}  dyn={dyn}  out={outc}  {note}")
            w.writerow([now, op, dyn, outc, note])
            fh.flush()
            if "WATCHDOG" in note:
                break
            time.sleep(args.interval * 60)

    print(f"\nsaved {out}")
    print("\n== VERDICT")
    if "WATCHDOG" in verdict:
        print(f"   {verdict}")
        print("   O4 CONFIRMED: a watchdog exists. Every active charger must be rewritten")
        print("   every cycle. Re-derive the R8 write budget and the R5 20/min limit, and")
        print("   revisit the deadband — 30 rewrites/cycle needs >=2 min of write spreading.")
    else:
        print(f"   {verdict} over {args.hours} h.")
        print("   O4 RESOLVED (negative): the setpoint persists. The deadband stands and the")
        print("   R8 budget is unchanged. Record the observation window in research.md — a")
        print("   negative result is only as strong as the hours it covers.")


if __name__ == "__main__":
    main()
