"""V11: announce the PC voice to the live server by hand and print exactly what it says."""
import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

DATA = r"C:/Users/dollr/BYoB Backups/kokoro"
CTX = ssl.create_default_context()

cfg = json.load(open(os.path.join(DATA, "config.json"), encoding="utf-8"))
state = json.load(open(os.path.join(DATA, "state.json"), encoding="utf-8"))
base = cfg["base_url"].rstrip("/")
print("--- state.json freshness")
now = time.time()
print("   url:", state.get("url"))
print("   server_ok:", state.get("server_ok"),
      "| state written", round(now - state.get("updated", 0)), "s ago",
      "| last announce ok", round(now - state.get("last_announce_ok", 0)), "s ago")

print("--- supervisor.log (tail, now)")
with open(os.path.join(DATA, "supervisor.log"), encoding="utf-8", errors="replace") as fh:
    for line in fh.readlines()[-12:]:
        print("   ", line.rstrip()[:160])

print("--- is the tunnel actually serving the voice?")
req = urllib.request.Request(state["url"] + "/health",
                             headers={"X-BYoB-Token": cfg["token"]})
try:
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        print("   tunnel /health ->", r.status, r.read()[:160])
except Exception as e:  # noqa: BLE001
    print("   tunnel /health failed:", repr(e))

print("--- announce by hand, exactly as the supervisor does")
body = {
    "user_id": cfg["user_id"], "url": state["url"], "token": cfg["token"],
    "device": "cuda", "version": "kokoro-1.1", "realtime_factor": 5.1,
    "voices_url": state["url"] + "/voices", "device_name": "BYoB Kokoro (PC)",
}
keeper = json.load(open(r"C:/Users/dollr/BYoB Backups/keeper/keeper.json", encoding="utf-8"))
if keeper.get("sync_key"):
    body["sync_key"] = keeper["sync_key"]
    print("   (with the account's sync key, the way the supervisor now does it)")
req = urllib.request.Request(base + "/api/tts/engine", data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json",
                                      "X-Kokoro-Key": cfg["token"],
                                      "X-Device-Token": cfg.get("device_token", "")})
try:
    with urllib.request.urlopen(req, timeout=40, context=CTX) as r:
        print("   ->", r.status, r.read()[:200])
except urllib.error.HTTPError as e:
    print("   ->", e.code, e.read()[:200])

print("--- engines right after")
with urllib.request.urlopen(
        base + "/api/tts/engines?user_id=" + urllib.parse.quote(cfg["user_id"]),
        timeout=40, context=CTX) as r:
    print("   ", json.loads(r.read())["engines"]["kokoro"])
