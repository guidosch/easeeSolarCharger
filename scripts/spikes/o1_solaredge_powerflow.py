#!/usr/bin/env python3
"""Spike O1 — does currentPowerFlow return LOAD and GRID for this specific site?

research.md R2 derives the whole surplus formula from this one endpoint:

    gridExport_kW  = connections contains {to: GRID} ?  GRID.currentPower : -GRID.currentPower
    surplusRaw_kW  = gridExport_kW + ownCharging_kW

LOAD and GRID are only present when the site has consumption metering installed. If they are
absent the formula changes to PV.currentPower minus a separate consumption series, at twice
the SolarEdge call cost — which would breach the 300/day budget derived in R3. Cheap to check
now, expensive to discover after packages/core/surplus.ts is written.

Run this in DAYLIGHT. At night PV is 0 and the direction check proves nothing.

Usage:
    SOLAREDGE_API_KEY=... SOLAREDGE_SITE_ID=... python3 scripts/spikes/o1_solaredge_powerflow.py

Costs exactly 1 call against the 300/day budget and writes the response to
fixtures/providers/solaredge/currentPowerFlow-live.json.
"""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 20
OUT = pathlib.Path("fixtures/providers/solaredge/currentPowerFlow-live.json")


def main():
    key, site = os.environ.get("SOLAREDGE_API_KEY"), os.environ.get("SOLAREDGE_SITE_ID")
    if not key or not site:
        sys.exit("set SOLAREDGE_API_KEY and SOLAREDGE_SITE_ID")

    url = (
        f"https://monitoringapi.solaredge.com/site/{urllib.parse.quote(site)}"
        f"/currentPowerFlow?api_key={urllib.parse.quote(key)}"
    )
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        if e.code == 429:
            sys.exit("HTTP 429 — the 300/day budget is already exhausted today.")
        sys.exit(f"HTTP {e.code}: {detail}")

    flow = body.get("siteCurrentPowerFlow")
    if not flow:
        sys.exit(f"unexpected shape, top-level keys: {list(body)}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Never write the api_key into the committed fixture.
    OUT.write_text(json.dumps(body, indent=2) + "\n")
    print(f"saved {OUT}")

    present = [k for k in ("PV", "LOAD", "GRID", "STORAGE") if k in flow]
    print(f"\nunit        : {flow.get('unit')}")
    print(f"elements    : {present}")
    for k in present:
        print(f"  {k:<8} {flow[k]}")
    conns = flow.get("connections", [])
    print(f"connections : {conns}")

    print("\n== VERDICT")
    if "LOAD" in flow and "GRID" in flow:
        # Reproduce the R2 derivation against the live reading.
        exporting = any(str(c.get("to", "")).upper() == "GRID" for c in conns)
        importing = any(str(c.get("from", "")).upper() == "GRID" for c in conns)
        grid = flow["GRID"].get("currentPower", 0)
        grid_export = grid if exporting else -grid
        print("   LOAD and GRID ARE present — O1 RESOLVED, R2's formula holds as written.")
        print(f"   direction   : {'export' if exporting else 'import' if importing else 'UNCLEAR'}")
        print(f"   gridExportKw: {grid_export} (negative = importing)")
        if not exporting and not importing:
            print("   !! connections named neither to:GRID nor from:GRID — inspect before")
            print("      trusting the sign. Inverting this is the costliest bug in R2.")
        if flow.get("PV", {}).get("currentPower", 0) == 0:
            print("   NOTE: PV is 0 — was this run at night? Re-run in daylight to see export.")
    else:
        print("   LOAD and/or GRID ABSENT — the site has no consumption metering exposed.")
        print("   O1 FAILS: R2's formula does not hold. Fall back to PV.currentPower minus a")
        print("   consumption series, which DOUBLES the call cost and breaks the R3 budget")
        print("   (192/day -> 384/day against 300). Re-plan before writing surplus.ts.")


if __name__ == "__main__":
    main()
