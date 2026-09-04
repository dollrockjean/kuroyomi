import unittest
import os
import sys
import json
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import database
import epub_parser
import sample_books
sys.path.append('/Users/rdoll/.gemini/antigravity/brain/c58f8699-3179-46c5-bf49-351707dccd79/scratch')
from test_epub import create_sample_epub

class NovelReaderUnitTests(unittest.TestCase):
    def setUp(self):
        self.test_db = os.path.join(os.path.dirname(__file__), "unit_test.db")
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        database.DB_PATH = self.test_db
        database.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            try:
                os.remove(self.test_db)
            except Exception:
                pass

    def test_user_and_remember_device(self):
        """Verify device registration, persistent lookup, and unlinking."""
        user_id = database.get_or_create_user("READER-KEY-999")
        self.assertTrue(user_id.startswith("usr_"))

        # Register device with Remember=True
        token = "ios_persistent_token_abc"
        database.register_device(user_id, token, "iPhone 15 (Safari)", "Mozilla/5.0 iOS", remember=True)

        # Lookup by token (Session auto-recovery)
        user_found = database.get_user_by_device(token)
        self.assertIsNotNone(user_found)
        self.assertEqual(user_found["id"], user_id)
        self.assertEqual(user_found["sync_key"], "READER-KEY-999")
        self.assertEqual(user_found["device_name"], "iPhone 15 (Safari)")

        # List user devices
        devices = database.get_user_devices(user_id)
        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["device_token"], token)

        # Unlink device
        database.unlink_device(user_id, token)
        self.assertIsNone(database.get_user_by_device(token))

    def test_epub_parsing_and_paragraph_indexing(self):
        """Verify that EPUB HTML is sanitized and tagged with data-pid and id for speech synthesis & resume."""
        raw_epub = create_sample_epub(
            "Reverend Ascension - Vol 1",
            "Gu Master",
            [
                ("Chapter 1: Spring Autumn Cicada", "<p>Man proposes, heaven disposes.</p><p>The past five hundred years felt like a dream.</p>"),
                ("Chapter 2: Moon Orchid", "<p>Night was tranquil as jade water.</p>")
            ]
        )

        res = epub_parser.parse_single_epub(raw_epub, "Reverend Ascension - Vol 1.epub")
        self.assertEqual(res['metadata']['title'], "Reverend Ascension - Vol 1")
        self.assertEqual(res['metadata']['author'], "Gu Master")
        self.assertEqual(len(res['chapters']), 2)

        ch1 = res['chapters'][0]
        self.assertEqual(ch1['title'], "Chapter 1: Spring Autumn Cicada")
        self.assertIn('data-pid="0"', ch1['content_html'])
        self.assertIn('id="p-0"', ch1['content_html'])
        self.assertIn('data-pid="1"', ch1['content_html'])
        self.assertIn('id="p-1"', ch1['content_html'])
        self.assertGreater(ch1['word_count'], 5)

        # Volume detection & base title extraction
        vol_num = epub_parser.detect_volume_number("Reverend Ascension - Vol 1.epub", res['metadata']['title'])
        base_title = epub_parser.extract_base_novel_title(res['metadata']['title'], "Reverend Ascension - Vol 1.epub")
        self.assertEqual(vol_num, 1)
        self.assertEqual(base_title, "Reverend Ascension")

    def test_demo_novel_seeding_and_multi_volume_structure(self):
        """Verify demo novel creates multi-volume series with sequential chapters."""
        user_id = database.get_or_create_user("DEMO_USER")
        sample_books.seed_demo_novel(user_id)

        conn = database.get_db()
        cur = conn.cursor()

        # Novel
        cur.execute("SELECT * FROM novels WHERE user_id = ?", (user_id,))
        novel = cur.fetchone()
        self.assertIsNotNone(novel)
        self.assertEqual(novel["title"], "Chronicles of the Aether Sovereign")

        # Volumes (Volume 1 and Volume 2)
        cur.execute("SELECT * FROM volumes WHERE novel_id = ? ORDER BY volume_number ASC", (novel["id"],))
        vols = cur.fetchall()
        self.assertEqual(len(vols), 2)
        self.assertEqual(vols[0]["volume_number"], 1)
        self.assertEqual(vols[1]["volume_number"], 2)

        # Chapters (10 total, global index 1 to 10)
        cur.execute("SELECT * FROM chapters WHERE novel_id = ? ORDER BY global_index ASC", (novel["id"],))
        chs = cur.fetchall()
        self.assertEqual(len(chs), 10)
        for idx, ch in enumerate(chs, 1):
            self.assertEqual(ch["global_index"], idx)

        # Initial progress created
        cur.execute("SELECT * FROM reading_progress WHERE user_id = ?", (user_id,))
        prog = cur.fetchone()
        self.assertIsNotNone(prog)
        self.assertEqual(prog["novel_id"], novel["id"])
        self.assertEqual(prog["paragraph_index"], 0)

        conn.close()

    def test_reading_progress_updates(self):
        """Verify updating progress to specific paragraph index and scroll percent."""
        user_id = database.get_or_create_user("DEMO_USER_2")
        sample_books.seed_demo_novel(user_id)

        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT id FROM novels WHERE user_id = ?", (user_id,))
        novel_id = cur.fetchone()["id"]
        cur.execute("SELECT id, volume_id FROM chapters WHERE novel_id = ? AND global_index = 4", (novel_id,))
        ch4 = cur.fetchone()

        now = time.time()
        # Save progress at Chapter 4, paragraph 7, scroll 64.5%
        cur.execute("""
            INSERT OR REPLACE INTO reading_progress (id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, ("prog_test", user_id, novel_id, ch4["volume_id"], ch4["id"], 7, 64.5, now))
        conn.commit()

        cur.execute("SELECT * FROM reading_progress WHERE user_id = ? AND novel_id = ?", (user_id, novel_id))
        saved = cur.fetchone()
        self.assertEqual(saved["chapter_id"], ch4["id"])
        self.assertEqual(saved["paragraph_index"], 7)
        self.assertEqual(saved["scroll_percent"], 64.5)

        conn.close()

    def test_user_settings(self):
        """Verify user themes and reader preferences."""
        user_id = database.get_or_create_user("SETTINGS_USER")
        conn = database.get_db()
        cur = conn.cursor()

        now = time.time()
        cur.execute("""
            INSERT INTO user_settings (user_id, theme, font_family, font_size, line_height, content_width, auto_scroll_speed, tts_voice, tts_rate, tts_pitch, library_view_mode, library_sort_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                theme = excluded.theme,
                font_family = excluded.font_family,
                font_size = excluded.font_size,
                line_height = excluded.line_height,
                content_width = excluded.content_width,
                auto_scroll_speed = excluded.auto_scroll_speed,
                tts_voice = excluded.tts_voice,
                tts_rate = excluded.tts_rate,
                tts_pitch = excluded.tts_pitch,
                library_view_mode = excluded.library_view_mode,
                library_sort_by = excluded.library_sort_by,
                updated_at = excluded.updated_at
        """, (user_id, "oled-blackout", "mono", 20, 2.0, "wide", 50, "Samantha", 1.2, 1.0, "tile", "last_read", now))
        conn.commit()

        cur.execute("SELECT * FROM user_settings WHERE user_id = ?", (user_id,))
        s = cur.fetchone()
        self.assertEqual(s["theme"], "oled-blackout")
        self.assertEqual(s["font_family"], "mono")
        self.assertEqual(s["font_size"], 20)
        self.assertEqual(s["line_height"], 2.0)
        self.assertEqual(s["content_width"], "wide")
        self.assertEqual(s["auto_scroll_speed"], 50)
        self.assertEqual(s["library_view_mode"], "tile")
        self.assertEqual(s["library_sort_by"], "last_read")
        self.assertEqual(s["tts_voice"], "Samantha")

        conn.close()

if __name__ == "__main__":
    unittest.main()
