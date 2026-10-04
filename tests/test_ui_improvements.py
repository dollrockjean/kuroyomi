import unittest
import os
import re
import struct
import json
import io
import time
import server
import database

class TestUIImprovements(unittest.TestCase):
    def setUp(self):
        database.init_db()

    def test_mobile_icons_exist_and_valid_png(self):
        """Verify icon-192, icon-512, apple-touch-icon exist and have correct PNG dimensions."""
        icon_dir = os.path.join(server.PUBLIC_DIR, "icons")
        
        expected_icons = {
            "icon-512.png": (512, 512),
            "icon-192.png": (192, 192),
            "apple-touch-icon.png": (180, 180)
        }

        for filename, (expected_w, expected_h) in expected_icons.items():
            path = os.path.join(icon_dir, filename)
            self.assertTrue(os.path.exists(path), f"File {filename} does not exist")
            
            with open(path, "rb") as f:
                header = f.read(24)
                self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n", f"{filename} is not a valid PNG header")
                width, height = struct.unpack(">II", header[16:24])
                self.assertEqual(width, expected_w, f"{filename} width mismatch: got {width}, expected {expected_w}")
                self.assertEqual(height, expected_h, f"{filename} height mismatch: got {height}, expected {expected_h}")

    def test_cover_upload_database_and_resilience(self):
        """Test novel cover upload with database fallback logic and byte size return."""
        user_id = database.get_or_create_user("cover_test_user")
        novel_id = f"nov_test_{int(time.time()*1000)}"

        conn = database.get_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO novels (id, title, author, description, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (novel_id, "Cover Test Novel", "Author", "Test description", user_id, time.time(), time.time())
        )
        conn.commit()
        conn.close()

        test_data_url = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
        
        # 1. Update with matching user_id
        updated = database.update_novel_cover(novel_id, user_id, test_data_url)
        self.assertTrue(updated)
        
        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT cover_data FROM novels WHERE id = ?", (novel_id,))
        row = cur.fetchone()
        conn.close()
        self.assertEqual(row[0], test_data_url)

        # 2. Update with guest fallback
        alt_data_url = "data:image/jpeg;base64,alt_sample_payload_data"
        updated_guest = database.update_novel_cover(novel_id, "guest", alt_data_url)
        self.assertTrue(updated_guest)

        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT cover_data FROM novels WHERE id = ?", (novel_id,))
        row = cur.fetchone()
        conn.close()
        self.assertEqual(row[0], alt_data_url)

    def test_reader_bottom_tip_markup_and_css(self):
        """Verify the bottom scroll tip markup and styling."""
        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        self.assertIn('id="readerChapterEndTip"', html)
        self.assertIn('id="readerChapterEndTipText"', html)
        self.assertIn('id="tipIconDown"', html)
        self.assertIn('Scroll down for next chapter', html)

        css_path = os.path.join(server.PUBLIC_DIR, "css", "brutalist.css")
        with open(css_path, "r", encoding="utf-8") as f:
            css = f.read()

        self.assertIn(".reader-chapter-end-tip", css)
        self.assertIn(".tip-icon-down", css)

    def test_audiobook_transport_bar_markup_and_css(self):
        """Verify the fullscreen audiobook transport bar and buttons."""
        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        self.assertIn('class="audiobook-transport-bar"', html)
        self.assertIn('id="audiobookTransportBar"', html)
        self.assertIn('id="modalPrevChapterBtn"', html)
        self.assertIn('id="modalPrevParaBtn"', html)
        self.assertIn('id="modalPlayPauseBtn"', html)
        self.assertIn('id="modalNextParaBtn"', html)
        self.assertIn('id="modalNextChapterBtn"', html)

        css_path = os.path.join(server.PUBLIC_DIR, "css", "brutalist.css")
        with open(css_path, "r", encoding="utf-8") as f:
            css = f.read()

        self.assertIn(".audiobook-transport-bar", css)
        self.assertIn(".audiobook-bar-btn", css)
        self.assertIn(".audiobook-bar-btn.audiobook-bar-play", css)

    def test_bionic_reading_integration_and_algorithm(self):
        """Verify Bionic Reading settings, toggles, italics support, and algorithm logic."""
        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        self.assertIn('id="quickSheetBionicBar"', html)
        self.assertIn('id="quickSheetBionicBtn"', html)
        self.assertIn('id="panelModeStandardBtn"', html)
        self.assertIn('id="panelModeBionicBtn"', html)
        self.assertIn('id="quickSheetBionicToggle"', html)
        self.assertIn('id="panelBionicToggle"', html)

        app_js_path = os.path.join(server.PUBLIC_DIR, "js", "app.js")
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()

        self.assertIn("bionic_reading: false", app_js)
        self.assertIn("quickSheetBionicBtn", app_js)
        self.assertIn("panelModeStandardBtn", app_js)
        self.assertIn("panelModeBionicBtn", app_js)

        reader_js_path = os.path.join(server.PUBLIC_DIR, "js", "reader.js")
        with open(reader_js_path, "r", encoding="utf-8") as f:
            reader_js = f.read()

        self.assertIn("renderChapterHtml", reader_js)
        self.assertIn("applyBionicToContent", reader_js)
        self.assertIn("toggleBionicReading", reader_js)
        self.assertIn("bionic-fixation", reader_js)
        self.assertIn("isItalic", reader_js)

        css_path = os.path.join(server.PUBLIC_DIR, "css", "brutalist.css")
        with open(css_path, "r", encoding="utf-8") as f:
            css = f.read()

        self.assertIn(".bionic-fixation", css)
        self.assertIn(".quick-sheet-bionic-bar", css)
        self.assertIn(".quick-bionic-btn", css)
        self.assertIn("em .bionic-fixation", css)
        self.assertIn("i .bionic-fixation", css)

        import math
        def bionic_word(w):
            l = len(w)
            if l <= 3:
                fix_len = 1
            elif l <= 6:
                fix_len = 2
            else:
                fix_len = math.ceil(l * 0.45)
            return f"<b>{w[:fix_len]}</b>{w[fix_len:]}"

        self.assertEqual(bionic_word("The"), "<b>T</b>he")
        self.assertEqual(bionic_word("book"), "<b>bo</b>ok")
        self.assertEqual(bionic_word("reader"), "<b>re</b>ader")
        self.assertEqual(bionic_word("reading"), "<b>read</b>ing")
        self.assertEqual(bionic_word("extraordinary"), "<b>extrao</b>rdinary")

    def test_narration_speed_row_visibility(self):
        """Verify Narration Speed row is hidden by default and only shown when active."""
        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        self.assertIn('id="quickSheetSpeedRow" style="display: none;"', html)

        app_js_path = os.path.join(server.PUBLIC_DIR, "js", "app.js")
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()

        self.assertIn("quickSheetSpeedRow", app_js)
        self.assertIn("isAudioActive", app_js)

        tts_js_path = os.path.join(server.PUBLIC_DIR, "js", "tts.js")
        with open(tts_js_path, "r", encoding="utf-8") as f:
            tts_js = f.read()

        self.assertIn("quickSheetSpeedRow", tts_js)

    def test_cover_upload_resilience_and_storage_methods(self):
        """Verify cover persistence with novel insert fallback and storage methods."""
        novel_id = f"nov_nonexistent_{int(time.time()*1000)}"
        test_cover = "data:image/jpeg;base64,sample_fallback_cover_data"
        updated = database.update_novel_cover(novel_id, "test_resilient_user", test_cover)
        self.assertTrue(updated)

        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT cover_data FROM novels WHERE id = ?", (novel_id,))
        row = cur.fetchone()
        conn.close()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], test_cover)

        storage_js_path = os.path.join(server.PUBLIC_DIR, "js", "storage.js")
        with open(storage_js_path, "r", encoding="utf-8") as f:
            storage_js = f.read()

        self.assertIn("setNovelCover", storage_js)
        self.assertIn("getNovelCover", storage_js)
        self.assertIn("updateCoverInMirror", storage_js)

    def test_audiobook_modal_speed_slider(self):
        """Verify narrator speed buttons replaced with slider in audiobook modal and live speed updates."""
        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        self.assertIn('id="audiobookModalSpeedSlider"', html)
        self.assertIn('id="audiobookModalSpeedVal"', html)
        self.assertNotIn('id="audiobookSpeedChips"', html)
        self.assertIn('min="0.5"', html)
        self.assertIn('max="2.5"', html)
        self.assertIn('step="0.05"', html)

        tts_js_path = os.path.join(server.PUBLIC_DIR, "js", "tts.js")
        with open(tts_js_path, "r", encoding="utf-8") as f:
            tts_js = f.read()

        self.assertIn("audiobookModalSpeedSlider", tts_js)
        self.assertIn("audiobookModalSpeedVal", tts_js)
        self.assertIn("this.blobCache.clear()", tts_js)
        self.assertIn("this.preloadedIndex = -1", tts_js)
        self.assertIn("this.audioElement.playbackRate = this.rate", tts_js)

    def test_bionic_fixation_stepper_and_controls(self):
        """Verify bionic fixation slider and 1.5x options on quick sheet and in preferences drawer."""
        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        self.assertIn('id="quickSheetBionicBar"', html)
        self.assertIn('id="quickBionicHeader"', html)
        self.assertIn('id="quickBionicSliderRow"', html)
        self.assertIn('id="quickSheetBionicSlider"', html)
        self.assertIn('id="qsBionicSizeVal"', html)
        self.assertIn('id="quickSheetBionicSizeStepper"', html)
        self.assertIn('id="qsBionicSizeDown"', html)
        self.assertIn('id="qsBionicSizeUp"', html)
        self.assertIn('id="bionicFixationSizeGroup"', html)
        self.assertIn('bionic-size-choice-btn', html)
        self.assertIn('data-bionic-size="1.5"', html)
        self.assertIn('id="quickSheetSpeedSlider"', html)

        css_path = os.path.join(server.PUBLIC_DIR, "css", "brutalist.css")
        with open(css_path, "r", encoding="utf-8") as f:
            css = f.read()

        self.assertIn("--bionic-fixation-scale", css)
        self.assertIn("--bionic-fixation-weight", css)
        self.assertIn(".quick-bionic-slider-row", css)
        self.assertIn(".quick-bionic-step-val", css)

        reader_js_path = os.path.join(server.PUBLIC_DIR, "js", "reader.js")
        with open(reader_js_path, "r", encoding="utf-8") as f:
            reader_js = f.read()

        self.assertIn("applyBionicSettings", reader_js)
        self.assertIn("setBionicFixationSize", reader_js)
        self.assertIn("stepBionicFixationSize", reader_js)
        self.assertIn("quickSheetBionicSlider", reader_js)

        app_js_path = os.path.join(server.PUBLIC_DIR, "js", "app.js")
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()

        self.assertIn("quickSheetBionicSlider", app_js)
        self.assertIn("quickSheetSpeedSlider", app_js)
        self.assertIn("bionic-size-choice-btn", app_js)

        # Check slider properties for 1.5x reachability and no overlap styles
        self.assertIn('id="quickSheetBionicSlider" class="range-slider" min="1.0" max="2.0" step="0.05"', html)
        self.assertIn('min-width: 0', css)
        self.assertIn('line-height: 1', css)
        self.assertIn('vertical-align: baseline', css)

    def test_progress_save_resilience_and_backward_navigation(self):
        """Verify progress saves handle missing volume_id, guest fallback, and bidirectional updates."""
        nov_id = f"nov_prog_test_{int(time.time()*1000)}"
        ch_id = f"ch_prog_test_{int(time.time()*1000)}"
        user_id = database.get_or_create_user("test_user_progress")
        database.ensure_user_exists("guest")

        conn = database.get_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO novels (id, title, author, description, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (nov_id, "Progress Test Novel", "Author", "Desc", user_id, time.time(), time.time())
        )
        vol_id = f"vol_prog_test_{int(time.time()*1000)}"
        cur.execute(
            "INSERT INTO volumes (id, novel_id, volume_number, title, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (vol_id, nov_id, 1, "Volume 1", "test.epub", time.time())
        )
        cur.execute(
            "INSERT INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (ch_id, nov_id, vol_id, 0, 0, "Chapter 1", "<p>Content</p>", 10)
        )
        conn.commit()
        conn.close()

        class MockHandler:
            def __init__(self):
                self.sent_json = None
                self.sent_status = 200
                self.headers = {}
            def send_json(self, data, status=200):
                self.sent_json = data
                self.sent_status = status

        # POST /api/progress without volume_id and without user_id (tests guest fallback and volume lookup)
        h_prog = MockHandler()
        server.NovelReaderHandler.handle_api_post(h_prog, "/api/progress", {
            "novel_id": nov_id,
            "chapter_id": ch_id,
            "scroll_percent": 42.5
        })
        self.assertEqual(h_prog.sent_status, 200)
        self.assertTrue(h_prog.sent_json.get("success"))

        # GET /api/last-read for guest
        h_last = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_last, "/api/last-read", {"user_id": ["guest"]})
        self.assertEqual(h_last.sent_status, 200)
        last_read = h_last.sent_json.get("last_read")
        self.assertIsNotNone(last_read)
        self.assertEqual(last_read.get("novel_id"), nov_id)
        self.assertEqual(last_read.get("chapter_id"), ch_id)

        # Check reader.js doesn't freeze saves or block backward navigation
        reader_js_path = os.path.join(server.PUBLIC_DIR, "js", "reader.js")
        with open(reader_js_path, "r", encoding="utf-8") as f:
            reader_js = f.read()

        self.assertNotIn("localScore > cloudScore", reader_js)
        self.assertIn("isRestoringScroll = false", reader_js)

        # Check sync.js preserves extraMeta
        sync_js_path = os.path.join(server.PUBLIC_DIR, "js", "sync.js")
        with open(sync_js_path, "r", encoding="utf-8") as f:
            sync_js = f.read()

        self.assertIn("record.extraMeta", sync_js)

    def test_service_worker_and_asset_version_bump(self):
        """Verify service worker cache name and asset version query strings match v38."""
        sw_path = os.path.join(server.PUBLIC_DIR, "sw.js")
        with open(sw_path, "r", encoding="utf-8") as f:
            sw_js = f.read()

        self.assertIn("byob-v38", sw_js)
        self.assertIn("v=38.0", sw_js)

        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            index_html = f.read()

        self.assertIn("brutalist.css?v=38.0", index_html)
        self.assertIn("app.js?v=38.0", index_html)
        self.assertIn("reader.js?v=38.0", index_html)
        self.assertIn("tts.js?v=38.0", index_html)
        self.assertIn("sync.js?v=38.0", index_html)

    def test_user_paragraph_normalization_and_synthesis(self):
        """Verify complex RPG paragraph with evolution arrows, ratios, and double colons is normalized and synthesized cleanly."""
        user_text = (
            "[Lich Lord of Abomination] (15/15):: Abilities- Summon Poison Totem(5/5), Summon Undead(5/5), "
            "Noxious Outburst(5/5), and Dereliction of the Saintly Poison Lord(5/5) >> "
            "[Abhorred Lich Emperor](45/45) :: Additional Abilities- Undead Legion(5/5), Will of the Undead Emperor(5/5), "
            "and Delay Death(5/5). Two Skill Trees for evolution are possible once sufficient points and a base requirement "
            "of two equivalent level sacrificial skills are reached: >> [Arch Lich Ra'Zan] :: A dreadful calamity steeped in death. "
            "Enhances all death aspect abilities, as well as gaining the capability of summoning Supreme Tier Undead. >> "
            "[Pernicious Death Lord] :: A being with utmost proficiency in the art of poison and death, gaining wide area of attack abilities that decimate its foes."
        )

        cleaned = server.normalize_text_for_narration(user_text)
        self.assertNotIn(">>", cleaned)
        self.assertNotIn("::", cleaned)
        self.assertNotIn("[Lich", cleaned)
        self.assertNotIn("(15/15)", cleaned)
        self.assertIn("15 of 15", cleaned)
        self.assertIn("5 of 5", cleaned)
        self.assertIn("evolving to", cleaned)

        # Synthesize speech
        audio = server.synthesize_speech(user_text, voice="en-US-BrianNeural")
        self.assertIsNotNone(audio)
        self.assertGreater(len(audio), 50000)

    def test_reading_progress_continuity_and_regression_protection(self):
        """Verify openNovel, checkRemoteSync, and sync.js prevent backward progress regression."""
        reader_js_path = os.path.join(server.PUBLIC_DIR, "js", "reader.js")
        with open(reader_js_path, "r", encoding="utf-8") as f:
            reader_js = f.read()

        # Verify chapter comparison protection in openNovel
        self.assertIn("localChIdx > cloudChIdx", reader_js)
        self.assertIn("cloudChIdx > localChIdx", reader_js)
        self.assertIn("chooseSource = (cloudTime > localTime + 60000) ? 'cloud' : 'local'", reader_js)

        # Verify chapter index regression protection in checkRemoteSync
        self.assertIn("curChIdx > remoteChIdx", reader_js)
        self.assertIn("this.saveCurrentProgress(null, null, true)", reader_js)

        # Verify immediate sync on chapter load
        self.assertIn("this.saveCurrentProgress(0, 0, true)", reader_js)

        # Verify beforeunload listener
        self.assertIn("beforeunload", reader_js)

        # Verify sync.js immediate flag and race sequence guard
        sync_js_path = os.path.join(server.PUBLIC_DIR, "js", "sync.js")
        with open(sync_js_path, "r", encoding="utf-8") as f:
            sync_js = f.read()

        self.assertIn("immediate = false", sync_js)
        self.assertIn("this._syncSeq", sync_js)
        self.assertIn("currentLocal.chapterId === record.chapter_id", sync_js)

    def test_animated_spinner_and_library_loader(self):
        """Verify @keyframes spin exists and library loader circle is animated."""
        css_path = os.path.join(server.PUBLIC_DIR, "css", "brutalist.css")
        with open(css_path, "r", encoding="utf-8") as f:
            css = f.read()

        self.assertIn("@keyframes spin", css)
        self.assertIn("transform: rotate(360deg)", css)
        self.assertIn(".spinner-brutal", css)
        self.assertIn("animation: spin 0.8s linear infinite", css)

        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            index_html = f.read()

        self.assertIn("@keyframes spin", index_html)
        self.assertIn(".spinner-brutal", index_html)
        self.assertIn('id="libraryInitLoader"', index_html)
        self.assertIn('class="spinner-brutal"', index_html)

        app_js_path = os.path.join(server.PUBLIC_DIR, "js", "app.js")
        with open(app_js_path, "r", encoding="utf-8") as f:
            app_js = f.read()

        self.assertIn('library-skeleton-loader', app_js)
        self.assertIn('class="spinner-brutal"', app_js)

    def test_audiobook_voice_loading_ui_isolated_and_dismisses(self):
        """Verify audiobook loading voice is rendered alone on screen and cleanly leaves on completion."""
        tts_js_path = os.path.join(server.PUBLIC_DIR, "js", "tts.js")
        with open(tts_js_path, "r", encoding="utf-8") as f:
            tts_js = f.read()

        # Loading screen should replace spokenEl innerHTML with only the loading placeholder
        self.assertIn("audiobook-loading-wrap", tts_js)
        self.assertIn("audiobook-sound-bars", tts_js)
        self.assertIn("Loading Voice...", tts_js)

        # Ensure obsolete inline strip badge that sat adjacent to text is completely removed
        self.assertNotIn("audiobookLoadingStatusIndicator", tts_js)
        self.assertNotIn("insertBefore(loadingBar", tts_js)

        # Ensure updateAudiobookModalContent() is called upon load completion to dismiss loading screen
        self.assertIn("this.updateAudiobookModalContent();\n\n      await this.audioElement.play()", tts_js)

    def test_decorated_words_normalization_preserves_words(self):
        """Verify words with symbols like <<Herald>> or <Herald> are preserved and vocalized, not stripped."""
        text1 = "The <<Herald>> arrived in the city."
        cleaned1 = server.normalize_text_for_narration(text1)
        self.assertIn("Herald", cleaned1)
        self.assertNotIn("<<", cleaned1)
        self.assertNotIn(">>", cleaned1)

        text2 = "<<A>> >> <<B>>"
        cleaned2 = server.normalize_text_for_narration(text2)
        self.assertIn("A", cleaned2)
        self.assertIn("B", cleaned2)
        self.assertIn("evolving to", cleaned2)

        text3 = "He obtained «Divine Blade» and 〈Shadow Shield〉."
        cleaned3 = server.normalize_text_for_narration(text3)
        self.assertIn("Divine Blade", cleaned3)
        self.assertIn("Shadow Shield", cleaned3)

    def test_tts_engine_single_audio_element_and_speed_sync(self):
        """Verify TTSEngine uses single audio element and centralized syncRateUI."""
        tts_js_path = os.path.join(server.PUBLIC_DIR, "js", "tts.js")
        with open(tts_js_path, "r", encoding="utf-8") as f:
            tts_js = f.read()

        # No secondary audio element or rogue keep alive looping track
        self.assertNotIn("this.secondaryAudioElement", tts_js)
        self.assertNotIn("this.keepAliveAudio", tts_js)

        # syncRateUI must exist and update sliders and labels
        self.assertIn("syncRateUI()", tts_js)
        self.assertIn("audiobookModalSpeedSlider", tts_js)
        self.assertIn("quickSheetSpeedSlider", tts_js)
        self.assertIn("ttsRateSlider", tts_js)

        # jumpToParagraph must handle paused state smoothly
        self.assertIn("jumpToParagraph(index, autoPlay = null)", tts_js)
        self.assertIn("this.updateAudiobookModalContent();", tts_js)
        self.assertIn("window.Reader.saveCurrentProgress(clampedIndex", tts_js)

        # MediaSession handlers wired
        self.assertIn("setActionHandler('play'", tts_js)
        self.assertIn("setActionHandler('pause'", tts_js)
        self.assertIn("setActionHandler('stop'", tts_js)
        self.assertIn("setActionHandler('nexttrack'", tts_js)
        self.assertIn("setActionHandler('previoustrack'", tts_js)

if __name__ == '__main__':
    unittest.main()

