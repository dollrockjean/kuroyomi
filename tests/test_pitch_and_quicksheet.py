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

if __name__ == "__main__":
    unittest.main()
