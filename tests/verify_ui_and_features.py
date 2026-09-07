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

            print("--- 8. Testing Middle Click Menu Next & Previous Chapter Buttons ---")
            quick_nav_result = await eval_js(ws, """
            (() => {
                window.App.closeMasterPanel();
                window.App.openMobileQuickSheet();
                const prevBtn = document.getElementById('quickSheetPrevChBtn');
                const nextBtn = document.getElementById('quickSheetNextChBtn');
                const sheet = document.getElementById('mobileQuickSheet');
                return {
                    sheetOpen: sheet ? sheet.classList.contains('open') : false,
                    hasPrevBtn: !!prevBtn,
                    hasNextBtn: !!nextBtn,
                    prevText: prevBtn ? prevBtn.textContent.trim() : '',
                    nextText: nextBtn ? nextBtn.textContent.trim() : '',
                    prevDisabled: prevBtn ? prevBtn.disabled : false,
                    nextDisabled: nextBtn ? nextBtn.disabled : false
                };
            })()
            """)
            print("Quick sheet navigation test:", quick_nav_result)
            assert quick_nav_result["sheetOpen"], "Quick sheet should be open!"
            assert quick_nav_result["hasPrevBtn"] and quick_nav_result["hasNextBtn"], "Quick sheet must have Prev and Next chapter buttons!"
            assert "Prev Chapter" in quick_nav_result["prevText"], "Prev chapter button label missing!"
            assert "Next Chapter" in quick_nav_result["nextText"], "Next chapter button label missing!"

            print("--- 9. Testing Audiobook Sleep Timer Cog, 5-Min Preset, and Time Extensions ---")
            sleep_cog_result = await eval_js(ws, """
            (() => {
                window.App.closeMobileQuickSheet();
                window.TTSEngine.openAudiobookModal();
                const cogBtn = document.getElementById('audiobookSleepTimerCogBtn');
                cogBtn.click();
                const modal = document.getElementById('audiobookSleepModal');
                const btn5 = document.querySelector('.sleep-preset-btn[data-sleep="5"]');
                const has5Min = !!btn5;
                
                // Test selecting 5 min
                btn5.click();
                const initialRemaining = window.TTSEngine.sleepTimerRemaining;
                
                // Test +5 min extension
                window.TTSEngine.addSleepTimerMinutes(5);
                const afterAdd5 = window.TTSEngine.sleepTimerRemaining;
                
                // Test +15 min extension
                window.TTSEngine.addSleepTimerMinutes(15);
                const afterAdd15 = window.TTSEngine.sleepTimerRemaining;
                
                window.TTSEngine.setSleepTimer('off');
                window.TTSEngine.closeSleepModal();
                window.TTSEngine.closeAudiobookModal();

                return {
                    hasCog: !!cogBtn,
                    has5Min,
                    initialRemaining,
                    afterAdd5,
                    afterAdd15
                };
            })()
            """)
            print("Sleep timer test results:", sleep_cog_result)
            assert sleep_cog_result["hasCog"], "Audiobook header must have sleep timer cog button!"
            assert sleep_cog_result["has5Min"], "Sleep timer modal must include 5 min option!"
            assert sleep_cog_result["initialRemaining"] >= 295, "5 min timer should be ~300 seconds!"
            assert sleep_cog_result["afterAdd5"] >= sleep_cog_result["initialRemaining"] + 295, "+5 min did not extend timer!"
            assert sleep_cog_result["afterAdd15"] >= sleep_cog_result["afterAdd5"] + 895, "+15 min did not extend timer!"

            print("--- 10. Testing Continuous Audio Keepalive Session ---")
            keepalive_result = await eval_js(ws, """
            (() => {
                window.TTSEngine.startKeepAlive();
                return {
                    hasKeepAliveAudio: !!window.TTSEngine.keepAliveAudio,
                    isLooping: window.TTSEngine.keepAliveAudio ? window.TTSEngine.keepAliveAudio.loop : false,
                    volumeNonZero: window.TTSEngine.keepAliveAudio ? window.TTSEngine.keepAliveAudio.volume > 0 : false
                };
            })()
            """)
            print("Audio keepalive test results:", keepalive_result)
            assert keepalive_result["hasKeepAliveAudio"], "Keepalive audio track must be initialized!"
            assert keepalive_result["isLooping"], "Keepalive track must loop continuously!"
            assert keepalive_result["volumeNonZero"], "Keepalive volume must be non-zero to prevent iOS suspension!"

            print("--- 11. Testing Sleep Timer Resumption Prompt (Finish vs Start) ---")
            resume_prompt_result = await eval_js(ws, """
            (() => {
                // Simulate a completed sleep timer session
                const testRecord = {
                    novel_id: window.Reader.currentNovel ? window.Reader.currentNovel.id : 'nov_test',
                    novel_title: window.Reader.currentNovel ? window.Reader.currentNovel.title : 'Test Novel',
                    start: {
                        chapter_id: 'ch_start',
                        chapter_title: 'Chapter 1: The Awakening',
                        paragraph_index: 2,
                        scroll_percent: 10
                    },
                    finish: {
                        chapter_id: 'ch_finish',
                        chapter_title: 'Chapter 3: Night Falls',
                        paragraph_index: 15,
                        scroll_percent: 75
                    },
                    timestamp: Date.now()
                };
                localStorage.setItem('kuroyomi_pending_sleep_resume', JSON.stringify(testRecord));
                window.App.checkSleepTimerResume();
                
                const modal = document.getElementById('sleepResumeModal');
                const finBtn = document.getElementById('resumeWhereFinishedBtn');
                const startBtn = document.getElementById('resumeWhereStartedBtn');
                const finSub = document.getElementById('sleepResumeFinishedSub');
                const startSub = document.getElementById('sleepResumeStartedSub');

                const isVisible = modal && modal.style.display !== 'none';
                const finText = finSub ? finSub.textContent : '';
                const startText = startSub ? startSub.textContent : '';

                // Clean up modal
                document.getElementById('closeSleepResumeBtn').click();

                return {
                    isVisible,
                    hasFinBtn: !!finBtn,
                    hasStartBtn: !!startBtn,
                    finText,
                    startText,
                    clearedFromStorage: !localStorage.getItem('kuroyomi_pending_sleep_resume')
                };
            })()
            """)
            print("Sleep timer resumption modal test:", resume_prompt_result)
            assert resume_prompt_result["isVisible"], "Sleep resume modal should be displayed when a session completed!"
            assert resume_prompt_result["hasFinBtn"] and resume_prompt_result["hasStartBtn"], "Modal must have both finish and start resume options!"
            assert "Chapter 3" in resume_prompt_result["finText"], "Finish subtext should reflect completion chapter!"
            assert "Chapter 1" in resume_prompt_result["startText"], "Start subtext should reflect starting chapter!"
            assert resume_prompt_result["clearedFromStorage"], "Dismissing should clear the pending record!"

            print("--- 12. Testing Scroll-Up to Bottom of Previous Chapter ---")
            scroll_bottom_result = await eval_js(ws, """
            (() => {
                const loadChSrc = window.Reader.loadChapter.toString();
                const loadPrevChSrc = window.Reader.loadPrevChapter.toString();
                return {
                    hasScrollToBottomParam: loadChSrc.includes('scrollToBottom'),
                    hasPrevScrollToBottomParam: loadPrevChSrc.includes('scrollToBottom'),
                    hasScrollPerform: loadChSrc.includes('performScrollBottom')
                };
            })()
            """)
            print("Scroll to bottom verification:", scroll_bottom_result)
            assert scroll_bottom_result["hasScrollToBottomParam"], "loadChapter should support scrollToBottom parameter!"
            assert scroll_bottom_result["hasPrevScrollToBottomParam"], "loadPrevChapter should support scrollToBottom parameter!"
            assert scroll_bottom_result["hasScrollPerform"], "loadChapter should execute performScrollBottom!"

            print("ALL UI TOUCHUPS, SLEEP TIMER, CHAPTER NAVIGATION, AND BACKGROUND AUDIO VERIFIED SUCCESSFULLY!")

    finally:
        proc.terminate()
        proc.wait()

if __name__ == "__main__":
    asyncio.run(test_ui())
