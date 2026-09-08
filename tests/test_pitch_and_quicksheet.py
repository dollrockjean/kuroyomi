import unittest
import os
import sys
import tempfile
import urllib.parse
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

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
        # Simulate chapterList and candidate selection
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

            cloud_idx = next((i for i, c in enumerate(ch_list) if c["id"] == cloud["chapter_id"]), -1) if has_cloud else -1
            local_idx = next((i for i, c in enumerate(ch_list) if c["id"] == local["chapterId"]), -1) if has_local else -1

            choose_source = None
            if has_local and has_cloud:
                if local_idx != -1 and cloud_idx != -1:
                    if local_idx > cloud_idx:
                        choose_source = 'local'
                    elif cloud_idx > local_idx:
                        choose_source = 'cloud'
                    else:
                        local_score = (local.get("paragraphIndex", 0) * 1000) + local.get("scrollPercent", 0)
                        cloud_score = (cloud.get("paragraph_index", 0) * 1000) + cloud.get("scroll_percent", 0)
                        if local_score > cloud_score:
                            choose_source = 'local'
                        elif cloud_score > local_score:
                            choose_source = 'cloud'
                        else:
                            choose_source = 'local' if local.get("savedAt", 0) >= (cloud.get("updated_at", 0) * 1000) else 'cloud'
                elif local_idx != -1:
                    choose_source = 'local'
                elif cloud_idx != -1:
                    choose_source = 'cloud'
            elif has_local:
                choose_source = 'local'
            elif has_cloud:
                choose_source = 'cloud'

            return choose_source

        # Case 1: Local is ahead in chapter sequence -> must choose local
        local_ahead = {"chapterId": "ch_5", "paragraphIndex": 2, "scrollPercent": 10.0, "savedAt": 2000}
        cloud_behind = {"chapter_id": "ch_2", "paragraph_index": 15, "scroll_percent": 90.0, "updated_at": 1.0}
        self.assertEqual(resolve_progress(local_ahead, cloud_behind, chapter_list), 'local')

        # Case 2: Cloud is ahead in chapter sequence (read on another device) -> must choose cloud
        local_behind = {"chapterId": "ch_2", "paragraphIndex": 15, "scrollPercent": 90.0, "savedAt": 1000}
        cloud_ahead = {"chapter_id": "ch_4", "paragraph_index": 0, "scroll_percent": 0.0, "updated_at": 3.0}
        self.assertEqual(resolve_progress(local_behind, cloud_ahead, chapter_list), 'cloud')

        # Case 3: Same chapter, local paragraph ahead -> must choose local
        local_same_ch_ahead = {"chapterId": "ch_3", "paragraphIndex": 8, "scrollPercent": 20.0, "savedAt": 2000}
        cloud_same_ch_behind = {"chapter_id": "ch_3", "paragraph_index": 2, "scroll_percent": 50.0, "updated_at": 1.0}
        self.assertEqual(resolve_progress(local_same_ch_ahead, cloud_same_ch_behind, chapter_list), 'local')

        # Case 4: Same chapter, cloud paragraph ahead -> must choose cloud
        local_same_ch_behind = {"chapterId": "ch_3", "paragraphIndex": 2, "scrollPercent": 20.0, "savedAt": 1000}
        cloud_same_ch_ahead = {"chapter_id": "ch_3", "paragraph_index": 5, "scroll_percent": 10.0, "updated_at": 2.0}
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

if __name__ == "__main__":
    unittest.main()
