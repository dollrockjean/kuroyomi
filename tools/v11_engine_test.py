import os
"""V11 engine test: on a simulated iPhone 16 Pro Max, does the reader pick Kokoro through the server?

Loads the live site in WebKit with Rocco's account id and the saved engine choice on it, lets the
app probe, then reports what the reader would use and what the server actually speaks.
"""
import json
import shutil
import tempfile

LIVE = "https://byob-webnovel-reader.onrender.com"
USER_ID = "usr_c6f9fe287176"
DEVICE_TOKEN = os.environ.get("DEVICE_TOKEN", "")
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")


def live_engines_payload():
    """The live server's own /api/tts/engines answer for Rocco's account, fetched for real."""
    import ssl
    import urllib.parse
    import urllib.request
    url = (LIVE + "/api/tts/engines?user_id=" + urllib.parse.quote(USER_ID))
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    with urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context()) as r:
        return r.read().decode("utf-8")


def main():
    from playwright.sync_api import sync_playwright

    profile = tempfile.mkdtemp(prefix="v11-eng-")
    try:
        with sync_playwright() as p:
            ctx = p.webkit.launch_persistent_context(
                profile, viewport={"width": 440, "height": 956}, device_scale_factor=3,
                is_mobile=True, has_touch=True, user_agent=UA, service_workers="allow")
            ctx.add_init_script(f"""
              try {{
                localStorage.setItem('byob_user_id', {USER_ID!r});
                localStorage.setItem('byob_device_token', {DEVICE_TOKEN!r});
                localStorage.setItem('byob_remember_device', '1');
                localStorage.setItem('byob_tts_engine', 'auto');
              }} catch (e) {{}}
            """)
            page = ctx.new_page()
            logs = []
            page.on("console", lambda m: logs.append(m.text[:200]))
            page.goto(LIVE + "/", wait_until="load", timeout=90000)
            page.wait_for_timeout(6000)

            print("--- what the page thinks it is")
            print(json.dumps(page.evaluate("""() => ({
              storedUserId: localStorage.getItem('byob_user_id'),
              storageUserId: window.Storage ? window.Storage.getUserId() : null,
              syncUserId: window.SyncService ? window.SyncService.currentUserId : null,
              engineModeStored: localStorage.getItem('byob_tts_engine'),
              engineMode: window.TTSEngine ? window.TTSEngine.engineMode : null
            })"""), indent=1))

            # A clean install makes its own account, and the PC checks in under Rocco's, so the test
            # account cannot see it. Hand this page the live server's real answer for his account
            # instead, which tests the part that matters: with the PC up, what does the reader pick?
            real = live_engines_payload()
            print("--- the live server's real answer for Rocco's account")
            print("   ", json.dumps(json.loads(real)["engines"]["kokoro"]))
            page.route("**/api/tts/engines*", lambda route: route.fulfill(
                status=200, content_type="application/json", body=real))

            print("--- raw engines fetch from inside the page")
            print(json.dumps(page.evaluate("""async () => {
              const uid = window.Storage ? window.Storage.getUserId() : '';
              const r = await fetch('/api/tts/engines?user_id=' + encodeURIComponent(uid),
                { headers: { 'X-Device-Token': localStorage.getItem('byob_device_token') || '' } });
              return { status: r.status, body: (await r.json()).engines.kokoro };
            }"""), indent=1))

            print("--- after a forced probe")
            page.evaluate("window.TTSEngine.probeEngines(true)")
            page.wait_for_timeout(5000)
            print(json.dumps(page.evaluate("""() => ({
              mode: window.TTSEngine.engineMode,
              kokoro: window.TTSEngine.kokoro,
              usable: window.TTSEngine.kokoroUsable(),
              next: window.TTSEngine.engineForNextFetch(),
              status: window.TTSEngine.engineStatusText()
            })"""), indent=1))

            print("--- what the server speaks for this page (engine the app would ask for)")
            print(json.dumps(page.evaluate("""async (uid) => {
              const engine = window.TTSEngine.engineForNextFetch();
              const url = engine === 'kokoro'
                ? '/api/tts/speak?engine=kokoro&user_id=' + encodeURIComponent(uid)
                  + '&text=' + encodeURIComponent('Verification line for version eleven.')
                  + '&voice=' + encodeURIComponent(window.TTSEngine.kokoroVoiceFor(window.TTSEngine.selectedVoice))
                : '/api/tts/speak?text=' + encodeURIComponent('Verification line.')
                  + '&voice=' + encodeURIComponent(window.TTSEngine.selectedVoice);
              const r = await fetch(url);
              const b = await r.blob();
              return { asked: engine, status: r.status, served: r.headers.get('X-BYoB-Engine'),
                       bytes: b.size, type: b.type };
            }""", USER_ID), indent=1))

            print("--- default (no saved choice) on a clean install")
            ctx2 = p.webkit.launch_persistent_context(
                tempfile.mkdtemp(prefix="v11-eng2-"), viewport={"width": 440, "height": 956},
                device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=UA,
                service_workers="allow")
            ctx2.add_init_script(f"""
              try {{
                localStorage.setItem('byob_user_id', {USER_ID!r});
                localStorage.setItem('byob_device_token', {DEVICE_TOKEN!r});
              }} catch (e) {{}}
            """)
            q = ctx2.new_page()
            q.goto(LIVE + "/", wait_until="load", timeout=90000)
            q.wait_for_timeout(6000)
            q.evaluate("window.TTSEngine.probeEngines(true)")
            q.wait_for_timeout(5000)
            print(json.dumps(q.evaluate("""() => ({
              mode: window.TTSEngine.engineMode,
              kokoro: window.TTSEngine.kokoro,
              next: window.TTSEngine.engineForNextFetch(),
              status: window.TTSEngine.engineStatusText()
            })"""), indent=1))
            ctx2.close()

            print("--- console (tail)")
            for line in logs[-20:]:
                print("   ", line)
            ctx.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
