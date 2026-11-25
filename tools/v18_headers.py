"""What the live server tells a browser to cache, and for how long.

A phone can only be as new as its service worker, and the browser decides whether to even look
for a new sw.js from the Cache-Control on the last one it fetched. Prints the caching headers for
the shell files so that decision is visible instead of assumed.
"""
import sys, time, urllib.error, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://byob-webnovel-reader.onrender.com"
FILES = ["/sw.js", "/", "/index.html", "/js/tts.js", "/js/app.js", "/manifest.json"]
WATCH = ("cache-control", "etag", "last-modified", "expires", "content-length", "content-type")

for f in FILES:
    t0 = time.time()
    try:
        req = urllib.request.Request(BASE + f, headers={"User-Agent": "v18-header-check"})
        with urllib.request.urlopen(req, timeout=90) as r:
            code, hdrs, body = r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        code, hdrs, body = e.code, e.headers, e.read()
    except Exception as e:  # noqa: BLE001 - a probe should report, not crash
        print(f"{f:16} ERROR {e}")
        continue
    print(f"{f:16} {code}  {round(time.time() - t0, 2)}s  {len(body)} bytes")
    for h in WATCH:
        if hdrs.get(h):
            print(f"{'':18}{h}: {hdrs.get(h)}")
