"""V18c: read the live server's voice diary as the account owner.

Reads the account id and sync key from the keeper's config on this PC (never prints the key),
asks the live server for /api/tts/diag, /api/tts/engines and /api/devices, and prints a plain summary.

Run:  python tools/v18c_diag.py [--raw]
"""
import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

CFG = os.path.join(os.path.expanduser("~"), "BYoB Backups", "keeper", "keeper.json")


def load():
    with open(CFG, "r", encoding="utf-8") as f:
        c = json.load(f)
    return c["base_url"].rstrip("/"), c["user_id"], c["sync_key"]


def get(base, path, params=None, timeout=90):
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    r = urllib.request.Request(url, headers={"User-Agent": "BYoB-V18c/1"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400]
    except Exception as e:  # noqa: BLE001
        return 0, repr(e)


def ts(v):
    try:
        return datetime.datetime.fromtimestamp(float(v)).strftime("%H:%M:%S")
    except Exception:  # noqa: BLE001
        return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", action="store_true")
    a = ap.parse_args()
    base, uid, key = load()
    print("server:", base, " account:", uid[:8] + "..(" + str(len(uid)) + " chars)")
    code, h = get(base, "/health")
    print("/health", code, h)
    code, eng = get(base, "/api/tts/engines", {"user_id": uid, "sync_key": key})
    print("/api/tts/engines", code, json.dumps(eng)[:600] if not isinstance(eng, str) else eng)
    code, dev = get(base, "/api/devices", {"user_id": uid, "sync_key": key})
    if isinstance(dev, dict):
        print("/api/devices", code, "count:", len(dev.get("devices", [])))
        for d in dev.get("devices", []):
            print("   ", json.dumps(d)[:300])
    else:
        print("/api/devices", code, dev)
    code, diag = get(base, "/api/tts/diag", {"user_id": uid, "sync_key": key})
    if not isinstance(diag, dict):
        print("/api/tts/diag", code, diag)
        return 1
    if a.raw:
        print(json.dumps(diag, indent=1)[:20000])
        return 0
    ev = diag.get("diary") or diag.get("events") or diag.get("log") or []
    print("/api/tts/diag", code, "entries:", len(ev))
    for k, v in diag.items():
        if k not in ("events", "log"):
            print("  ", k, "=", json.dumps(v)[:300])
    kinds = {}
    for e in ev:
        kinds[e.get("kind") or e.get("event") or "?"] = kinds.get(e.get("kind") or e.get("event") or "?", 0) + 1
    print("  kinds:", kinds)
    print("  --- all entries, oldest first ---")
    for e in ev:
        t = ts(e.get("t") or e.get("time") or 0)
        print("  ", t, json.dumps({k: v for k, v in e.items() if k not in ("t", "time")})[:260])
    return 0


if __name__ == "__main__":
    sys.exit(main())
