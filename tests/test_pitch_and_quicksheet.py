import unittest
import os
import sys
import tempfile
import urllib.parse
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)

import server
import database

class PitchAndQuickSheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        database.init_db()

    def test_01_normalize_pitch(self):
        self.assertEqual(server.normalize_pitch("+0Hz"), "+0Hz")
        self.assertEqual(server.normalize_pitch("+10Hz"), "+10Hz")
        self.assertEqual(server.normalize_pitch("-15Hz"), "-15Hz")
        self.assertEqual(server.normalize_pitch("5"), "+5Hz")
        self.assertEqual(server.normalize_pitch("-5"), "-5Hz")
        self.assertEqual(server.normalize_pitch("0"), "+0Hz")
        self.assertEqual(server.normalize_pitch("100"), "+50Hz")
        self.assertEqual(server.normalize_pitch("-99"), "-50Hz")
        self.assertEqual(server.normalize_pitch(""), "+0Hz")
        self.assertEqual(server.normalize_pitch(None), "+0Hz")
        self.assertEqual(server.normalize_pitch("invalid"), "+0Hz")

    def test_02_synthesize_with_pitch(self):
        data = server.synthesize_speech("Testing pitch synthesis.", voice="en-US-BrianNeural", rate="+0%", pitch="+5Hz")
        self.assertIsNotNone(data)
        self.assertTrue(len(data) > 100)

        norm_pitch = server.normalize_pitch("+5Hz")
        import hashlib
        clean_text = server.normalize_text_for_narration("Testing pitch synthesis.")
        cache_key = hashlib.sha256(f"en-US-BrianNeural_+0%_{norm_pitch}_{clean_text}".encode('utf-8')).hexdigest()
        cache_file = os.path.join(server.TTS_CACHE_DIR, f"{cache_key}.mp3")
        self.assertTrue(os.path.exists(cache_file))

    def test_03_settings_pitch_persistence(self):
        user_id = "test_user_pitch_1"
        database.ensure_user_exists(user_id)
        conn = database.get_db()
        cur = conn.cursor()
        import time
        cur.execute("""
            INSERT INTO user_settings (user_id, tts_pitch, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET tts_pitch = excluded.tts_pitch, updated_at = excluded.updated_at
        """, (user_id, 10.0, time.time()))
        conn.commit()

        cur.execute("SELECT tts_pitch FROM user_settings WHERE user_id = ?", (user_id,))
        row = cur.fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["tts_pitch"], 10.0)
        conn.close()

    def test_04_reading_progress_continuity_resolution(self):
        # Simulate chapterList and candidate selection with new timestamp precedence
        chapter_list = [
            {"id": "ch_1", "title": "Chapter 1"},
            {"id": "ch_2", "title": "Chapter 2"},
            {"id": "ch_3", "title": "Chapter 3"},
            {"id": "ch_4", "title": "Chapter 4"},
            {"id": "ch_5", "title": "Chapter 5"},
        ]

        def resolve_progress(local, cloud, ch_list):
            has_cloud = bool(cloud and cloud.get("chapter_id"))
            has_local = bool(local and local.get("chapterId"))

            choose_source = None
            if has_local and has_cloud:
                local_time = local.get("savedAt", 0)
                cloud_time = int(cloud.get("updated_at", 0) * 1000)

                if local_time > 0 and cloud_time > 0 and abs(local_time - cloud_time) > 1500:
                    choose_source = 'local' if local_time > cloud_time else 'cloud'
                elif local_time > 0 and cloud_time == 0:
                    choose_source = 'local'
                elif cloud_time > 0 and local_time == 0:
                    choose_source = 'cloud'
                else:
                    if local.get("chapterId") == cloud.get("chapter_id"):
                        local_score = (local.get("paragraphIndex", 0) * 1000) + local.get("scrollPercent", 0)
                        cloud_score = (cloud.get("paragraph_index", 0) * 1000) + cloud.get("scroll_percent", 0)
                        if local_score != cloud_score:
                            choose_source = 'local' if local_score > cloud_score else 'cloud'
                        else:
                            choose_source = 'local' if local_time >= cloud_time else 'cloud'
                    else:
                        choose_source = 'local' if local_time >= cloud_time else 'cloud'
            elif has_local:
                choose_source = 'local'
            elif has_cloud:
                choose_source = 'cloud'

            return choose_source

        # Case 1: Local navigated BACKWARD from Ch 5 to Ch 2 more recently -> local wins (Ch 2)
        local_went_back = {"chapterId": "ch_2", "paragraphIndex": 0, "scrollPercent": 0.0, "savedAt": 5000}
        cloud_old_ahead = {"chapter_id": "ch_5", "paragraph_index": 2, "scroll_percent": 10.0, "updated_at": 1.0}
        self.assertEqual(resolve_progress(local_went_back, cloud_old_ahead, chapter_list), 'local')

        # Case 2: Cloud read ahead on another device more recently -> cloud wins (Ch 4)
        local_behind = {"chapterId": "ch_2", "paragraphIndex": 15, "scrollPercent": 90.0, "savedAt": 1000}
        cloud_ahead = {"chapter_id": "ch_4", "paragraph_index": 0, "scroll_percent": 0.0, "updated_at": 8.0}
        self.assertEqual(resolve_progress(local_behind, cloud_ahead, chapter_list), 'cloud')

        # Case 3: Same chapter, local paragraph ahead -> local wins
        local_same_ch_ahead = {"chapterId": "ch_3", "paragraphIndex": 8, "scrollPercent": 20.0, "savedAt": 2000}
        cloud_same_ch_behind = {"chapter_id": "ch_3", "paragraph_index": 2, "scroll_percent": 50.0, "updated_at": 1.0}
        self.assertEqual(resolve_progress(local_same_ch_ahead, cloud_same_ch_behind, chapter_list), 'local')

        # Case 4: Same chapter, cloud paragraph ahead -> cloud wins
        local_same_ch_behind = {"chapterId": "ch_3", "paragraphIndex": 2, "scrollPercent": 20.0, "savedAt": 1000}
        cloud_same_ch_ahead = {"chapter_id": "ch_3", "paragraph_index": 5, "scroll_percent": 10.0, "updated_at": 5.0}
        self.assertEqual(resolve_progress(local_same_ch_behind, cloud_same_ch_ahead, chapter_list), 'cloud')

    def test_05_settings_api_pitch_save_and_retrieve(self):
        from test_api_direct import create_mock_handler
        user_id = database.get_or_create_user("PITCH_API_USER")

        # Save pitch setting via POST /api/settings
        settings_payload = json.dumps({
            "user_id": user_id,
            "theme": "dark-oled",
            "tts_pitch": -8.0,
            "tts_rate": 1.2
        }).encode('utf-8')

        h_post = create_mock_handler("/api/settings", "POST", settings_payload)
        h_post.do_POST()
        res_post = json.loads(h_post.wfile.getvalue().decode('utf-8'))
        self.assertTrue(res_post.get("success"))

        # Retrieve settings via GET /api/settings?user_id=...
        h_get = create_mock_handler(f"/api/settings?user_id={user_id}", "GET")
        h_get.do_GET()
        res_get = json.loads(h_get.wfile.getvalue().decode('utf-8'))
        self.assertIn("settings", res_get)
        self.assertEqual(res_get["settings"]["tts_pitch"], -8.0)
        self.assertEqual(res_get["settings"]["tts_rate"], 1.2)
        self.assertEqual(res_get["settings"]["theme"], "dark-oled")

    def test_06_novels_progress_overall_percent(self):
        """Test that /api/novels calculates accurate progress_overall_percent."""
        from test_api_direct import create_mock_handler
        import sample_books
        uid = "test_progress_bar_user"
        database.ensure_user_exists(uid)
        sample_books.seed_demo_novel(uid)

        # Query novels
        h = create_mock_handler(f"/api/novels?user_id={uid}", "GET")
        h.do_GET()
        res = json.loads(h.wfile.getvalue().decode('utf-8'))
        self.assertIn("novels", res)
        novels = res["novels"]
        self.assertGreaterEqual(len(novels), 1)
        nov = novels[0]
        self.assertIn("progress_overall_percent", nov)
        self.assertIsInstance(nov["progress_overall_percent"], (int, float))

    def test_07_pairing_deduplication(self):
        """Test that restoring a backup never duplicates existing novel titles or re-injects demo books."""
        user_id = "test_dedup_user"
        database.ensure_user_exists(user_id)

        # First restore
        b1 = {
            "novels": [{
                "id": "nov_real_book_1",
                "title": "Solo Leveling Chronicles",
                "author": "Chugong",
                "description": "Hunter novel",
                "cover_data": None
            }],
            "volumes": [],
            "chapters": [],
            "progress": [],
            "settings": {}
        }
        database.import_backup_data(b1, user_id)

        # Attempt to import demo novel when real book exists
        b_demo = {
            "novels": [{
                "id": "nov_demo_test",
                "title": "Chronicles of the Aether Sovereign",
                "author": "BYoB Team",
                "description": "Demo book",
                "cover_data": None
            }],
            "volumes": [],
            "chapters": [],
            "progress": [],
            "settings": {}
        }
        database.import_backup_data(b_demo, user_id)

        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT id, title FROM novels WHERE user_id = ?", (user_id,))
        rows = cur.fetchall()
        conn.close()

        titles = [r["title"] for r in rows]
        self.assertIn("Solo Leveling Chronicles", titles)
        # Demo novel must be rejected because real book exists
        self.assertNotIn("Chronicles of the Aether Sovereign", titles)

    def test_08_deobfuscation_and_clean_text(self):
        """Test that dotted words like cl.u.s.t.ered or f.u.c.k are de-obfuscated."""
        import epub_parser
        raw = "The monsters were cl.u.s.t.ered together. What the f.u.c.k is that? Visit example.com in the U.S.A. at 5 p.m."
        cleaned = epub_parser.deobfuscate_censored_words(raw)
        self.assertIn("clustered", cleaned)
        self.assertIn("fuck", cleaned)
        # Whitelisted acronyms and domains must remain intact
        self.assertIn("example.com", cleaned)
        self.assertIn("U.S.A.", cleaned)
        self.assertIn("p.m.", cleaned)

        # Also test API endpoint
        from test_api_direct import create_mock_handler
        import sample_books
        uid = "test_clean_user"
        database.ensure_user_exists(uid)
        nid = sample_books.seed_demo_novel(uid)

        # Insert a chapter with dotted words
        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT id FROM chapters WHERE novel_id = ? LIMIT 1", (nid,))
        ch_id = cur.fetchone()["id"]
        cur.execute("UPDATE chapters SET content_html = ? WHERE id = ?", ("<p>They were cl.u.s.t.ered and s.h.i.t occurred.</p>", ch_id))
        conn.commit()
        conn.close()

        clean_body = json.dumps({"novel_id": nid, "user_id": uid}).encode('utf-8')
        h_clean = create_mock_handler("/api/novels/clean-text", "POST", clean_body)
        h_clean.do_POST()
        clean_res = json.loads(h_clean.wfile.getvalue().decode('utf-8'))
        self.assertTrue(clean_res["success"])
        self.assertGreaterEqual(clean_res["cleaned_chapters"], 1)

        # Verify chapter content cleaned in DB
        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT content_html FROM chapters WHERE id = ?", (ch_id,))
        updated_content = cur.fetchone()["content_html"]
        conn.close()
        self.assertIn("clustered", updated_content)
        self.assertIn("shit", updated_content)

if __name__ == "__main__":
    unittest.main()
