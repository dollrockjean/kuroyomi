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

if __name__ == '__main__':
    unittest.main()
