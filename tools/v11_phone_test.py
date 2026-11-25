import os
"""V11 phone test: does an app stuck on the old v55.0 service worker update itself to 55.1?

Runs a small reverse proxy on 127.0.0.1 in front of the live site so the origin stays the same
while the served sw.js / index.html flip from the old stamp (55.0) to the real one (55.1).
127.0.0.1 is a secure context, so service workers install normally.

Then checks, on a simulated iPhone 16 Pro Max in WebKit, that the page ends up on 55.1 by itself
and that the reader picks Kokoro through the server rather than Edge.
"""
import http.server
import json
import shutil
import socketserver
import ssl
import tempfile
import threading
import urllib.error
import urllib.request

LIVE = "https://byob-webnovel-reader.onrender.com"
PORT = 8799
USER_ID = "usr_c6f9fe287176"
DEVICE_TOKEN = os.environ.get("DEVICE_TOKEN", "")
MODE = {"value": "old"}  # "old" rewrites the version stamp to 55.0; "new" passes through
CTX = ssl.create_default_context()
HOP = {"transfer-encoding", "content-encoding", "content-length", "connection",
       "keep-alive", "strict-transport-security", "content-security-policy"}


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet
        pass

    def _forward(self, body=None):
        url = LIVE + self.path
        req = urllib.request.Request(url, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() in ("host", "accept-encoding", "connection", "content-length"):
                continue
            req.add_header(k, v)
        req.add_header("Accept-Encoding", "identity")
        try:
            with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
                status, hdrs, data = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            status, hdrs, data = e.code, e.headers, e.read()
        except Exception as e:  # noqa: BLE001
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
            print("   proxy error", self.path, repr(e))
            return

        if MODE["value"] == "old":
            p = self.path.split("?")[0]
            if p == "/sw.js":
                data = data.replace(b"ASSET_VERSION = '55.1'", b"ASSET_VERSION = '55.0'")
            elif p in ("/", "/index.html"):
                data = data.replace(b"?v=55.1", b"?v=55.0")

        self.send_response(status)
        for k, v in hdrs.items():
            if k.lower() in HOP:
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:  # noqa: BLE001
            pass

    def do_GET(self):
        self._forward()

    def do_HEAD(self):
        self._forward()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self._forward(self.rfile.read(n) if n else b"")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def state(page):
    return page.evaluate("""async () => {
      const keys = await caches.keys();
      const reg = await navigator.serviceWorker.getRegistration();
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src'));
      let cachedTts = null;
      for (const k of keys) {
        const c = await caches.open(k);
        const reqs = await c.keys();
        const hit = reqs.find(r => r.url.includes('tts.js'));
        if (hit) cachedTts = hit.url;
      }
      return {
        cacheKeys: keys,
        controller: reg && reg.active ? reg.active.scriptURL : null,
        waiting: !!(reg && reg.waiting),
        scripts: scripts.filter(s => s.includes('.js')),
        cachedTts,
        ttsEngine: window.TTSEngine ? {
          mode: window.TTSEngine.engineMode,
          kokoro: window.TTSEngine.kokoro,
          next: window.TTSEngine.engineForNextFetch(),
          status: window.TTSEngine.engineStatusText()
        } : null
      };
    }""")


def main():
    httpd = Server(("127.0.0.1", PORT), Proxy)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{PORT}"
    print("proxy up on", base)

    from playwright.sync_api import sync_playwright

    profile = tempfile.mkdtemp(prefix="v11-webkit-")
    try:
        with sync_playwright() as p:
            ctx = p.webkit.launch_persistent_context(
                profile,
                viewport={"width": 440, "height": 956},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
                user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
                            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
                service_workers="allow",
            )
            ctx.add_init_script(f"""
              try {{
                localStorage.setItem('byob_user_id', {USER_ID!r});
                localStorage.setItem('byob_device_token', {DEVICE_TOKEN!r});
                localStorage.setItem('byob_remember_device', '1');
              }} catch (e) {{}}
            """)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            logs = []
            page.on("console", lambda m: logs.append(m.text[:160]))

            print("=== A. first load with the OLD 55.0 service worker")
            MODE["value"] = "old"
            page.goto(base + "/", wait_until="load", timeout=90000)
            page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=60000)
            page.wait_for_timeout(4000)
            a = state(page)
            print("   cacheKeys:", a["cacheKeys"])
            print("   scripts:", a["scripts"][:8])
            print("   cached tts.js:", a["cachedTts"])

            print("=== A2. reload once so the old worker is really in charge")
            page.reload(wait_until="load", timeout=90000)
            page.wait_for_timeout(3000)
            a2 = state(page)
            print("   cacheKeys:", a2["cacheKeys"], "controller:", a2["controller"])
            print("   scripts:", a2["scripts"][:8])

            print("=== B. the real 55.1 is served again; load as the phone would")
            MODE["value"] = "new"
            page.reload(wait_until="load", timeout=90000)
            # the new worker has to install, take over and tell the page to reload
            b = state(page)
            for _ in range(12):
                page.wait_for_timeout(2500)
                b = state(page)
                if any("55.1" in k for k in b["cacheKeys"]) and all("55.0" not in s for s in b["scripts"]):
                    break
            print("   cacheKeys:", b["cacheKeys"])
            print("   scripts:", b["scripts"][:8])
            print("   cached tts.js:", b["cachedTts"])
            print("   controller:", b["controller"])
            updated = any("55.1" in k for k in b["cacheKeys"]) and all("55.0" not in s for s in b["scripts"])
            print("   SELF-UPDATED TO 55.1:", updated)

            print("=== C. which engine does the reader pick, and does the server speak Kokoro")
            page.wait_for_timeout(2000)
            page.evaluate("window.TTSEngine && window.TTSEngine.probeEngines(true)")
            page.wait_for_timeout(6000)
            c = state(page)
            print("   TTSEngine:", json.dumps(c["ttsEngine"]))
            relay = page.evaluate("""async () => {
              const uid = localStorage.getItem('byob_user_id');
              const r = await fetch('/api/tts/speak?engine=kokoro&user_id=' + encodeURIComponent(uid)
                + '&text=' + encodeURIComponent('Phone test line.') + '&voice=af_heart');
              const b = await r.blob();
              return { status: r.status, engine: r.headers.get('X-BYoB-Engine'), bytes: b.size,
                       type: b.type };
            }""")
            print("   in-page relay call:", relay)

            print("=== D. fresh install (no old cache) on the live site over HTTPS")
            profile2 = tempfile.mkdtemp(prefix="v11-webkit2-")
            ctx2 = p.webkit.launch_persistent_context(
                profile2,
                viewport={"width": 440, "height": 956},
                device_scale_factor=3, is_mobile=True, has_touch=True,
                user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
                            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
                service_workers="allow",
            )
            ctx2.add_init_script(f"""
              try {{
                localStorage.setItem('byob_user_id', {USER_ID!r});
                localStorage.setItem('byob_device_token', {DEVICE_TOKEN!r});
                localStorage.setItem('byob_remember_device', '1');
              }} catch (e) {{}}
            """)
            p2 = ctx2.pages[0] if ctx2.pages else ctx2.new_page()
            p2.goto(LIVE + "/", wait_until="load", timeout=90000)
            p2.wait_for_timeout(8000)
            p2.evaluate("window.TTSEngine && window.TTSEngine.probeEngines(true)")
            p2.wait_for_timeout(6000)
            d = state(p2)
            print("   cacheKeys:", d["cacheKeys"])
            print("   scripts:", d["scripts"][:8])
            print("   TTSEngine:", json.dumps(d["ttsEngine"]))
            p2.screenshot(path=r"C:/Users/dollr/Claude Projects/novel-reader/tools/v11-fresh-iphone.png")
            ctx2.close()
            shutil.rmtree(profile2, ignore_errors=True)

            print("=== console (tail)")
            for line in logs[-25:]:
                print("   ", line)
            ctx.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
