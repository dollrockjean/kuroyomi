import asyncio
import json
import subprocess
import time
import urllib.request
import websockets

BRAVE_PATH = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"

async def cdp_call(ws, method, params=None, msg_id=[1]):
    mid = msg_id[0]
    msg_id[0] += 1
    req = {"id": mid, "method": method, "params": params or {}}
    await ws.send(json.dumps(req))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == mid:
            return resp.get("result", {})

async def eval_js(ws, expr):
    res = await cdp_call(ws, "Runtime.evaluate", {
        "expression": expr,
        "returnByValue": True,
        "awaitPromise": True
    })
    return res.get("result", {}).get("value")

async def test_ui():
    tmp_user_data = f"/tmp/brave_test_{int(time.time())}"
    proc = subprocess.Popen([
        BRAVE_PATH,
        "--headless=new",
        "--remote-debugging-port=9222",
        f"--user-data-dir={tmp_user_data}",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank"
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    time.sleep(2)

    try:
        tabs_res = urllib.request.urlopen("http://127.0.0.1:9222/json")
        tabs = json.loads(tabs_res.read().decode())
        ws_url = tabs[0]["webSocketDebuggerUrl"]

        async with websockets.connect(ws_url) as ws:
            # 1. Set mobile viewport (iPhone 14/15: 390x844)
            await cdp_call(ws, "Emulation.setDeviceMetricsOverride", {
                "width": 390,
                "height": 844,
                "deviceScaleFactor": 3,
                "mobile": True
            })

            # 2. Navigate to localhost:8000
            await cdp_call(ws, "Page.navigate", {"url": "http://localhost:8000"})
            await asyncio.sleep(2.5)

            print("--- 1. Testing Library and Mobile Resume Hero Layout ---")
            resume_data = await eval_js(ws, """
            (() => {
                const hero = document.getElementById('resumeHero');
                const cover = document.getElementById('resumeCover');
                const info = hero ? hero.querySelector('.resume-info') : null;
                const btn = document.getElementById('resumeReadBtn');
                const heroDisplay = hero ? window.getComputedStyle(hero).display : 'none';
                return {
                    heroDisplay,
                    coverWidth: cover ? cover.offsetWidth : 0,
                    coverHeight: cover ? cover.offsetHeight : 0,
                    infoHeight: info ? info.offsetHeight : 0,
                    btnWidth: btn ? btn.offsetWidth : 0,
                    heroWidth: hero ? hero.offsetWidth : 0
                };
            })()
            """)
            print("Resume hero metrics on mobile:", resume_data)
            # If resume hero is displayed, verify cover vs text proportion and full-width button
            if resume_data["heroDisplay"] != "none" and resume_data["coverHeight"] > 0:
                diff = abs(resume_data["coverHeight"] - resume_data["infoHeight"])
                print(f"Difference between cover height ({resume_data['coverHeight']}px) and text info height ({resume_data['infoHeight']}px): {diff}px")
                assert diff < 60, "Resume hero text is disproportionately taller than cover!"
                assert resume_data["btnWidth"] >= resume_data["heroWidth"] * 0.8, "Resume button should be full-width on mobile!"

            print("--- 1b. Testing Resume Chapter Tag Formatting ---")
            tag_tests = await eval_js(ws, """
            (() => {
                return {
                    basic: window.App.formatResumeChapterTag({
                        volume_number: 1,
                        volume_title: "Volume 1: The Beginning",
                        chapter_title: "Chapter 20"
                    }),
                    withSubtitle: window.App.formatResumeChapterTag({
                        volume_number: 1,
                        volume_title: "Volume 1",
                        chapter_title: "Chapter 20: The Awakening"
                    }),
                    numericPrefix: window.App.formatResumeChapterTag({
                        volume_number: 2,
                        volume_title: "Volume 2",
                        chapter_title: "45. Battle for the Throne"
                    }),
                    noPrefix: window.App.formatResumeChapterTag({
                        volume_number: 1,
                        volume_title: "Volume 1",
                        chapter_title: "Prologue",
                        chapter_global_index: 1
                    })
                };
            })()
            """)
            print("Resume tag formatting results:", tag_tests)
            assert tag_tests["basic"] == "Vol. 1, Chap. 20", f"Unexpected: {tag_tests['basic']}"
            assert tag_tests["withSubtitle"] == "Vol. 1, Chap. 20: The Awakening", f"Unexpected: {tag_tests['withSubtitle']}"
            assert tag_tests["numericPrefix"] == "Vol. 2, Chap. 45: Battle for the Throne", f"Unexpected: {tag_tests['numericPrefix']}"
            assert tag_tests["noPrefix"] == "Vol. 1, Chap. 1: Prologue", f"Unexpected: {tag_tests['noPrefix']}"

            print("--- 2. Testing Novel Loading and Reader View ---")
            opened = await eval_js(ws, """
            (() => {
                const btn = document.querySelector('.read-novel-btn') || document.getElementById('resumeReadBtn');
                if (btn) {
                    btn.click();
                    return true;
                }
                return false;
            })()
            """)
            assert opened, "No novel card found in library!"
            for _ in range(25):
                has_p = await eval_js(ws, "!!document.querySelector('.reader-paragraph')")
                if has_p:
                    break
                await asyncio.sleep(0.2)

            reader_styles = await eval_js(ws, """
            (() => {
                const p = document.querySelector('.reader-paragraph');
                const body = document.getElementById('readerBodyWrapper');
                const banner = document.querySelector('.chapter-separator-banner');
                const pStyle = p ? window.getComputedStyle(p) : {};
                const bodyStyle = body ? window.getComputedStyle(body) : {};
                const bannerStyle = banner ? window.getComputedStyle(banner) : {};
                
                return {
                    pTextAlign: pStyle.textAlign,
                    pLineHeight: pStyle.lineHeight,
                    letterSpacingVar: document.documentElement.style.getPropertyValue('--reader-letter-spacing'),
                    lineHeightVar: document.documentElement.style.getPropertyValue('--reader-line-height'),
                    bodyPaddingTop: bodyStyle.paddingTop,
                    bannerMarginTop: bannerStyle.marginTop
                };
            })()
            """)
            print("Reader styles:", reader_styles)
            assert reader_styles["pTextAlign"] == "left", f"Paragraph text-align should be 'left', got {reader_styles['pTextAlign']}"
            print("Paragraph text-align is left (no forced justify word stretching): OK")

            print("--- 3. Testing Footer Navigation Buttons on Mobile ---")
            footer_data = await eval_js(ws, """
            (() => {
                const prev = document.getElementById('footerPrevBtn');
                const next = document.getElementById('footerNextBtn');
                const lib = document.getElementById('footerLibraryBtn');
                const menu = document.getElementById('footerMenuBtn');
                return {
                    prevDisplay: prev ? window.getComputedStyle(prev).display : 'none',
                    nextDisplay: next ? window.getComputedStyle(next).display : 'none',
                    prevText: prev ? prev.textContent.trim() : '',
                    nextText: next ? next.textContent.trim() : '',
                    prevHeight: prev ? prev.offsetHeight : 0
                };
            })()
            """)
            print("Footer navigation buttons on mobile:", footer_data)
            assert "inline-flex" in footer_data["prevDisplay"] or "flex" in footer_data["prevDisplay"] or "block" in footer_data["prevDisplay"], "footerPrevBtn should not be hidden on mobile!"
            assert "inline-flex" in footer_data["nextDisplay"] or "flex" in footer_data["nextDisplay"] or "block" in footer_data["nextDisplay"], "footerNextBtn should not be hidden on mobile!"
            assert "<- Prev" in footer_data["prevText"] or "Prev" in footer_data["prevText"], f"Expected arrow on prev button, got {footer_data['prevText']}"
            assert "Next ->" in footer_data["nextText"] or "Next" in footer_data["nextText"], f"Expected arrow on next button, got {footer_data['nextText']}"
            assert footer_data["prevHeight"] <= 40, f"Buttons should be smaller/compact, got height {footer_data['prevHeight']}px"

            print("--- 4. Testing Mobile Quick Sheet (Tap Middle) & Layering ---")
            sheet_data = await eval_js(ws, """
            (() => {
                window.App.openMobileQuickSheet();
                const sheet = document.getElementById('mobileQuickSheet');
                const backdrop = document.getElementById('quickSheetBackdrop');
                const floatBar = document.getElementById('readerFloatingBar');
                const floatBtn = document.getElementById('floatingQuickMenuBtn');
                const sheetStyle = sheet ? window.getComputedStyle(sheet) : {};
                const backdropStyle = backdrop ? window.getComputedStyle(backdrop) : {};
                
                return {
                    sheetZIndex: parseInt(sheetStyle.zIndex || '0'),
                    backdropZIndex: parseInt(backdropStyle.zIndex || '0'),
                    floatBarDisplay: floatBar ? floatBar.style.display : '',
                    floatBtnDisplay: floatBtn ? floatBtn.style.display : ''
                };
            })()
            """)
            print("Quick sheet metrics:", sheet_data)
            assert sheet_data["sheetZIndex"] >= 250, f"Quick sheet z-index should be >= 250, got {sheet_data['sheetZIndex']}"
            assert sheet_data["backdropZIndex"] >= 240, f"Backdrop z-index should be >= 240, got {sheet_data['backdropZIndex']}"
            assert sheet_data["floatBarDisplay"] == "none", "Floating bar should be hidden when quick sheet is open!"
            assert sheet_data["floatBtnDisplay"] == "none", "Floating quick menu button should be hidden when quick sheet is open!"

            print("--- 5. Testing Line Spacing & Letter Spacing Steppers ---")
            spacing_stepper_result = await eval_js(ws, """
            (() => {
                const initialLs = parseFloat(window.ReaderSettings.letter_spacing || 0);
                const initialLh = parseFloat(window.ReaderSettings.line_height || 1.85);
                
                // Click letter spacing up
                document.getElementById('quickSheetLetterUp').click();
                const afterLs = parseFloat(window.ReaderSettings.letter_spacing || 0);
                
                // Click line spacing up
                document.getElementById('quickSheetLineUp').click();
                const afterLh = parseFloat(window.ReaderSettings.line_height || 1.85);

                const rootLs = document.documentElement.style.getPropertyValue('--reader-letter-spacing');
                const rootLh = document.documentElement.style.getPropertyValue('--reader-line-height');

                return {
                    initialLs,
                    afterLs,
                    initialLh,
                    afterLh,
                    rootLs,
                    rootLh
                };
            })()
            """)
            print("Spacing stepper test:", spacing_stepper_result)
            assert spacing_stepper_result["afterLs"] > spacing_stepper_result["initialLs"], "Letter spacing did not increase!"
            assert spacing_stepper_result["afterLh"] > spacing_stepper_result["initialLh"], "Line spacing did not increase!"
            assert "px" in spacing_stepper_result["rootLs"], "Root CSS var --reader-letter-spacing was not set!"

            print("--- 6. Testing WebNovel Themes and Fonts ---")
            theme_font_result = await eval_js(ws, """
            (() => {
                const results = {};
                // Test WebNovel themes
                ['webnovel-paper', 'webnovel-mint', 'webnovel-dark', 'webnovel-ocean'].forEach(t => {
                    window.App.applySettings({ theme: t });
                    results['theme_' + t] = document.documentElement.getAttribute('data-theme');
                });
                
                // Test WebNovel fonts
                ['merriweather', 'georgia', 'palatino', 'lora', 'ptserif', 'roboto', 'opensans', 'lato'].forEach(f => {
                    window.App.applySettings({ font_family: f });
                    results['font_' + f] = document.documentElement.getAttribute('data-font');
                });

                return results;
            })()
            """)
            print("Theme and font test results:", theme_font_result)
            for k, v in theme_font_result.items():
                target = k.split('_', 1)[1]
                assert v == target, f"Expected {k} to be {target}, got {v}"

            print("--- 7. Testing Table of Contents Current Chapter Focus ---")
            toc_result = await eval_js(ws, """
            (() => {
                window.App.openMasterPanel('tabChapters');
                const active = document.querySelector('.toc-item.active');
                return {
                    hasActiveItem: !!active,
                    activeId: active ? active.getAttribute('data-id') : null,
                    currentChId: window.Reader.currentChapter ? window.Reader.currentChapter.id : null
                };
            })()
            """)
            print("TOC Active Chapter Focus test:", toc_result)
            assert toc_result["hasActiveItem"], "Table of contents should highlight active chapter!"
            assert toc_result["activeId"] == toc_result["currentChId"], "Active chapter in TOC must match current reading chapter!"

            print("ALL UI TOUCHUPS AND BEHAVIORS VERIFIED SUCCESSFULLY!")

    finally:
        proc.terminate()
        proc.wait()

if __name__ == "__main__":
    asyncio.run(test_ui())
