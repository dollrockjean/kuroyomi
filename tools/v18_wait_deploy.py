"""Wait until the live site serves a given build, then say how long it took.

Render redeploys on its own after a push and a chat that checks once too early reports the old
build and calls the fix missing.

    python tools/v18_wait_deploy.py 55.6 [--minutes 12]
"""
import argparse
import re
import time
import urllib.request

BASE = "https://byob-webnovel-reader.onrender.com"


def served():
    try:
        with urllib.request.urlopen(BASE + "/sw.js", timeout=90) as r:
            m = re.search(r"ASSET_VERSION\s*=\s*'([0-9.]+)'", r.read().decode("utf-8", "replace"))
            return m.group(1) if m else ""
    except Exception as e:  # noqa: BLE001 - a waiter should report, not crash
        return "error: %s" % e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("want")
    ap.add_argument("--minutes", type=float, default=12)
    args = ap.parse_args()
    t0 = time.time()
    while time.time() - t0 < args.minutes * 60:
        now = served()
        print("%4ds  %s" % (round(time.time() - t0), now), flush=True)
        if now == args.want:
            print("DEPLOYED after %d s" % round(time.time() - t0))
            return
        time.sleep(20)
    print("STILL NOT %s after %g minutes" % (args.want, args.minutes))


if __name__ == "__main__":
    main()
