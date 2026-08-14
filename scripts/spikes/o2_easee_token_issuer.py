#!/usr/bin/env python3
"""Spike O2 — does Easee publish a JWKS, and is it the one that signs our tokens?

Research R6 claims Easee publishes no JWKS, and deviation D1 in plan.md rests entirely on
that claim. The unauthenticated half of this spike has already disproved the first part: a
live Keycloak realm with an RS256 signing key exists at auth.easee.com/realms/easee.

What is still open is the *link*: POST /api/accounts/login is a custom .NET service, not a
Keycloak proxy, so the token it returns may or may not be issued by that realm. Only a real
login answers that, which is what this script does.

Usage:
    EASEE_USERNAME=you@example.com EASEE_PASSWORD='...' python3 scripts/spikes/o2_easee_token_issuer.py

Reads no files and writes no secrets. The token is decoded, never stored.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

LOGIN_URL = "https://api.easee.com/api/accounts/login"
DISCOVERY_URL = "https://auth.easee.com/realms/easee/.well-known/openid-configuration"
TIMEOUT = 20


def get_json(url, data=None, headers=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Accept": "application/json", **(headers or {})},
        method="POST" if data is not None else "GET",
    )
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def b64url(segment):
    """Decode a JWT segment, restoring the padding JWTs strip."""
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


def main():
    user, pw = os.environ.get("EASEE_USERNAME"), os.environ.get("EASEE_PASSWORD")
    if not user or not pw:
        sys.exit("set EASEE_USERNAME and EASEE_PASSWORD (a real Easee account)")

    print("== 1. unauthenticated: is there a JWKS at all?")
    try:
        disco = get_json(DISCOVERY_URL)
        jwks = get_json(disco["jwks_uri"])
    except urllib.error.URLError as e:
        sys.exit(f"discovery/JWKS fetch failed: {e}")
    sig_keys = {k["kid"]: k.get("alg") for k in jwks["keys"] if k.get("use") == "sig"}
    print(f"   issuer   : {disco['issuer']}")
    print(f"   jwks_uri : {disco['jwks_uri']}")
    print(f"   signing keys: {len(sig_keys)} -> {sig_keys}")

    print("\n== 2. authenticated: who actually signs the API's token?")
    try:
        tokens = get_json(LOGIN_URL, {"userName": user, "password": pw})
    except urllib.error.HTTPError as e:
        sys.exit(f"login failed: HTTP {e.code} {e.read().decode(errors='replace')[:300]}")

    access = tokens.get("accessToken")
    if not access:
        sys.exit(f"no accessToken in response; keys were {list(tokens)}")
    parts = access.split(".")
    if len(parts) != 3:
        print(f"   !! token is NOT a JWT ({len(parts)} segments) — it is opaque.")
        print("   VERDICT: D1 stands. An opaque token cannot be verified locally at all.")
        return

    header, payload = b64url(parts[0]), b64url(parts[1])
    alg, kid, iss = header.get("alg"), header.get("kid"), payload.get("iss")
    print(f"   header.alg : {alg}")
    print(f"   header.kid : {kid}")
    print(f"   payload.iss: {iss}")
    print(f"   claims     : {sorted(payload)}")
    # The UserId claim is what FR-003 authorizes against — confirm its exact name.
    for name in ("UserId", "userId", "sub", "preferred_username", "email"):
        if name in payload:
            print(f"   claim {name!r} present")

    print("\n== VERDICT")
    if alg and alg.startswith("HS"):
        print(f"   alg={alg} is SYMMETRIC. Local verification needs a shared secret we do")
        print("   not have. D1 STANDS — keep cached remote validation.")
    elif kid and kid in sig_keys:
        print(f"   kid={kid} IS published in the Easee JWKS, and iss={iss}.")
        print("   D1 IS INVALID: verify the signature locally against the JWKS, as the")
        print("   constitution requires. Update research.md R6 and plan.md Complexity Tracking.")
    elif iss and "auth.easee.com" in str(iss):
        print(f"   iss points at Keycloak but kid={kid} is not in the current JWKS.")
        print("   Likely key rotation — re-fetch the JWKS (honour cache headers) and re-check.")
    else:
        print(f"   Token is a JWT (alg={alg}) but is NOT issued by the Keycloak realm")
        print(f"   (iss={iss}). No public key is available for it, so D1 STANDS.")


if __name__ == "__main__":
    main()
