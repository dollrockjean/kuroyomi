"""V11: is the PC still checking in with the live server, and what does the supervisor log say?"""
import json
import ssl
import time
import urllib.parse
import urllib.request

LIVE = "https://byob-webnovel-reader.onrender.com"
USER_ID = "usr_c6f9fe287176"
CTX = ssl.create_default_context()
LOG = r"C:/Users/dollr/BYoB Backups/kokoro/supervisor.log"
STATE = r"C:/Users/dollr/BYoB Backups/kokoro/state.json"


def fetch(url):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "v11-probe")
    with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
        return json.loads(r.read().decode("utf-8"))


print("--- live /health (boot id tells us if Render restarted)")
h = fetch(LIVE + "/health")
print("   ", h)

print("--- /api/tts/engines for Rocco, sampled over 3 minutes")
for i in range(7):
    d = fetch(LIVE + "/api/tts/engines?user_id=" + urllib.parse.quote(USER_ID))
    k = d["engines"]["kokoro"]
    print(f"   t+{i*30:>3}s available={k['available']} age={k.get('age_seconds')}")
    if i < 6:
        time.sleep(30)

print("--- supervisor.log (tail)")
try:
    with open(LOG, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    for line in lines[-25:]:
        print("   ", line.rstrip()[:200])
except Exception as e:  # noqa: BLE001
    print("   ", e)

print("--- state.json")
try:
    with open(STATE, encoding="utf-8") as fh:
        st = json.load(fh)
    print("   ", {k: ("<hidden>" if k in ("token", "key") else v) for k, v in st.items()})
except Exception as e:  # noqa: BLE001
    print("   ", e)
