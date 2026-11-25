"""V11 live verification: checks the deployed BYoB site and the PC voice lock.

Prints one line per check. Temporary verification helper, safe to delete.
"""
import email.message
import json
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://byob-webnovel-reader.onrender.com"
USER_ID = "usr_c6f9fe287176"
CTX = ssl.create_default_context()


def get(url, headers=None, data=None, method=None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=180, context=CTX) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except Exception as e:  # noqa: BLE001
        print("   request failed:", repr(e))
        return None, email.message.Message(), b""


print("--- 1. live sw.js ASSET_VERSION")
st, _, body = get(BASE + "/sw.js")
sw = body.decode("utf-8", "replace")
print("status", st)
for line in sw.splitlines():
    if "ASSET_VERSION =" in line or "CACHE_NAME =" in line:
        print("  ", line.strip()[:120])

print("--- 2. live index.html stamps")
st, _, body = get(BASE + "/")
html = body.decode("utf-8", "replace")
print("status", st)
print("  stamps:", sorted(set(re.findall(r"(?:js|css)/[\w.-]+\.(?:js|css)\?v=[\d.]+", html)))[:20])

print("--- 3. live tts.js relay path")
st, hdr, body = get(BASE + "/js/tts.js?v=55.1")
js = body.decode("utf-8", "replace")
print("status", st, "len", len(js), "cache-control", hdr.get("Cache-Control"))
for pat in ["/api/tts/speak?engine=kokoro", "'/api/tts/prefetch'", "info.url", "token"]:
    print(f"   {pat!r}: {js.count(pat)}")

print("--- 4. /api/tts/engines (no user, then real user)")
for uid in ("", USER_ID):
    st, _, body = get(BASE + "/api/tts/engines?user_id=" + urllib.parse.quote(uid))
    txt = body.decode("utf-8", "replace")
    try:
        k = json.loads(txt)["engines"]["kokoro"]
    except Exception:  # noqa: BLE001
        k = txt[:200]
    print(f"   user_id={uid!r} -> {st} kokoro={k}")

print("--- 5. relay speak through the server (GET, engine=kokoro)")
url = (BASE + "/api/tts/speak?engine=kokoro&user_id=" + urllib.parse.quote(USER_ID)
       + "&text=" + urllib.parse.quote("Verification line for version eleven.")
       + "&voice=af_heart")
st, hdr, body = get(url)
print("status", st, "engine-header", hdr.get("X-BYoB-Engine"), "ctype", hdr.get("Content-Type"), "bytes", len(body))
if st != 200:
    print("   body:", body[:300])

print("--- 6. plain edge speak (control)")
url = (BASE + "/api/tts/speak?text=" + urllib.parse.quote("Control line.")
       + "&voice=en-US-BrianNeural")
st, hdr, body = get(url)
print("status", st, "engine-header", hdr.get("X-BYoB-Engine"), "bytes", len(body))

print("--- 7. PC voice lock (local 127.0.0.1:8766, no key)")
for path in ["/health", "/tts?text=hi", "/voices", "/nope"]:
    st, hdr, body = get("http://127.0.0.1:8766" + path)
    print(f"   {path} -> {st} {body[:90]!r}")

print("--- 8. PC voice with key (proves the server itself is alive)")
key = None
try:
    with open(r"C:/Users/dollr/BYoB Backups/kokoro/config.json", encoding="utf-8") as fh:
        key = json.load(fh).get("token")
except Exception as e:  # noqa: BLE001
    print("   no config:", e)
if key:
    st, hdr, body = get("http://127.0.0.1:8766/health", {"X-BYoB-Token": key})
    print("   /health with key ->", st, body[:200].decode("utf-8", "replace") if isinstance(body, bytes) else body)
    st, hdr, body = get("http://127.0.0.1:8766/tts?text=" + urllib.parse.quote("hello there"),
                        {"X-BYoB-Token": key})
    print("   /tts with key ->", st, "bytes", len(body), "ctype", hdr.get("Content-Type"))
    st, hdr, body = get("http://127.0.0.1:8766/tts?text=hi&token=" + urllib.parse.quote(key))
    print("   /tts with old ?token= ->", st, body[:90])

print("--- 9. old ?token= query on engines / announce reachability")
st, hdr, body = get(BASE + "/api/tts/prefetch", {"Content-Type": "application/json"},
                    json.dumps({"user_id": USER_ID, "texts": ["warm up"], "voice": "af_heart"}).encode(),
                    "POST")
print("   POST /api/tts/prefetch ->", st, body[:200])
sys.stdout.flush()
