"""Ask the live BYoB server what the voice and the devices have been doing, as the account owner.

The sync key is read from the keeper config on this PC and is never printed.

    python tools/v18_diag.py            # voice diary, PC check-ins folded into one line
    python tools/v18_diag.py devices    # every device on the account and when it was last seen
    python tools/v18_diag.py engines    # what the app's engine probe is told
    python tools/v18_diag.py raw diag   # the untouched JSON of any of the above
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

PATHS = {"diag": "/api/tts/diag", "devices": "/api/devices", "engines": "/api/tts/engines"}
HOME = os.path.expanduser("~")
keeper = json.load(open(os.path.join(HOME, "BYoB Backups", "keeper", "keeper.json")))
base = keeper.get("base_url") or "https://byob-webnovel-reader.onrender.com"
args = [a for a in sys.argv[1:] if a != "raw"]
raw = "raw" in sys.argv[1:]
what = (args[0] if args else "diag").strip("/").replace("api/", "").replace("tts/", "")
path = PATHS.get(what, PATHS["diag"])

qs = urllib.parse.urlencode({"user_id": keeper["user_id"], "sync_key": keeper["sync_key"]})
try:
    with urllib.request.urlopen(f"{base}{path}?{qs}", timeout=90) as r:
        body, code = r.read().decode("utf-8", "replace"), r.status
except urllib.error.HTTPError as e:
    body, code = e.read().decode("utf-8", "replace"), e.code

print(f"HTTP {code}  {path}")
try:
    data = json.loads(body)
except ValueError:
    print(body[:2000])
    raise SystemExit(0)
if raw:
    print(json.dumps(data, indent=2))
    raise SystemExit(0)


def when(ts):
    return time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "-"


if path == PATHS["diag"]:
    print("server build:", data.get("asset_version"), " boot:", data.get("boot_id"),
          " now:", when(data.get("now")))
    print("pc:", json.dumps(data.get("pc")))
    diary = data.get("diary") or []
    print(f"diary: {len(diary)} entries, {when(diary[0]['at']) if diary else '-'}"
          f" .. {when(diary[-1]['at']) if diary else '-'}")
    run = 0
    for e in diary + [None]:
        if e is not None and e.get("what") == "PC checked in":
            run += 1
            continue
        if run:
            print(f"  [{run}x PC checked in]")
            run = 0
        if e is not None:
            rest = {k: v for k, v in e.items() if k not in ("at", "user", "what")}
            print(f"  {when(e['at'])}  {e['what']}  {json.dumps(rest)}")
elif path == PATHS["devices"]:
    devices = data if isinstance(data, list) else (data.get("devices") or [])
    print(f"{len(devices)} device(s), newest first:")
    for d in devices:
        print(f"  last seen {when(d.get('last_seen'))} "
              f"({round((time.time() - (d.get('last_seen') or 0)) / 60)} min ago)  "
              f"created {when(d.get('created_at'))}  name={d.get('device_name')!r}  "
              f"ua={str(d.get('user_agent'))[:120]!r}")
else:
    print(json.dumps(data, indent=2)[:3000])
