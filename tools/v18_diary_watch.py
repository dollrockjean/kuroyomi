"""Keep a copy of the server's voice diary on this PC, so a restart cannot erase the evidence.

Render's free plan holds the diary in memory. The server is redeployed or restarted several times
a day, and each time everything his phone did is gone. Three nights in a row the only honest answer
to "what did his phone ask for?" was "the diary was empty when we looked" (V13, V14, V15, V18).

This polls /api/tts/diag as the account owner and appends every entry it has not seen before to
~/BYoB Backups/kokoro/diary.log, one JSON object per line, with the server's boot id so restarts
are visible. PC check-ins are dropped by default: they are 45 seconds apart and drown everything.

    python tools/v18_diary_watch.py                 # run until stopped
    python tools/v18_diary_watch.py --once          # one pull, for a check
    python tools/v18_diary_watch.py --all           # keep the PC check-ins too
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
KEEPER = os.path.join(HOME, "BYoB Backups", "keeper", "keeper.json")
LOG = os.path.join(HOME, "BYoB Backups", "kokoro", "diary.log")


def pull(base, qs):
    try:
        with urllib.request.urlopen("%s/api/tts/diag?%s" % (base, qs), timeout=90) as r:
            return json.loads(r.read().decode("utf-8", "replace")), ""
    except urllib.error.HTTPError as e:
        return None, "HTTP %s" % e.code
    except Exception as e:  # noqa: BLE001 - a watcher must outlive a bad night of networking
        return None, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--all", action="store_true", help="keep the PC's own check-ins too")
    ap.add_argument("--every", type=float, default=25, help="seconds between pulls")
    args = ap.parse_args()

    with open(KEEPER, encoding="utf-8") as fh:
        keeper = json.load(fh)
    base = keeper.get("base_url") or "https://byob-webnovel-reader.onrender.com"
    qs = urllib.parse.urlencode({"user_id": keeper["user_id"], "sync_key": keeper["sync_key"]})
    os.makedirs(os.path.dirname(LOG), exist_ok=True)

    seen = set()
    last_boot = None
    while True:
        data, err = pull(base, qs)
        if data:
            boot = data.get("boot_id")
            if boot != last_boot:
                # A new boot means a new, empty diary on the server. Mark it, and forget what we
                # had seen: the entry keys start over.
                with open(LOG, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"local": time.time(), "event": "server restarted",
                                         "boot": boot, "build": data.get("asset_version")}) + "\n")
                seen.clear()
                last_boot = boot
            for e in data.get("diary") or []:
                if not args.all and e.get("what") == "PC checked in":
                    continue
                key = json.dumps(e, sort_keys=True)
                if key in seen:
                    continue
                seen.add(key)
                out = dict(e)
                out["local"] = time.time()
                out["boot"] = boot
                with open(LOG, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(out) + "\n")
            if len(seen) > 4000:
                seen.clear()
        elif err:
            with open(LOG, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"local": time.time(), "event": "could not read the diary",
                                     "why": err}) + "\n")
        if args.once:
            return
        time.sleep(args.every)


if __name__ == "__main__":
    main()
