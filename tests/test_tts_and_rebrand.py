import unittest
import json
import os
import io
from http.server import SimpleHTTPRequestHandler
import server
import database

class TestTTSAndRebrand(unittest.TestCase):
    def setUp(self):
        database.init_db()

    def test_server_health_service_name(self):
        self.assertEqual(server.TTS_CACHE_DIR.endswith("byob_tts_cache"), True)
        self.assertEqual(server.TTS_CONCURRENCY_SEMAPHORE._value, 6)

    def test_database_backup_app_name(self):
        user_id = database.get_or_create_user("test_byob_user")
        backup = database.export_backup_data(user_id)
        self.assertEqual(backup.get("app"), "byob")

    def test_index_html_rebranding(self):
        index_path = os.path.join(server.PUBLIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        self.assertIn("<title>BYoB · Bring Your Own Books</title>", html)
        self.assertIn('<meta name="apple-mobile-web-app-title" content="BYoB">', html)
        self.assertIn('<div class="logo-icon">B</div>', html)
        self.assertIn('<div class="logo-title">BYoB</div>', html)
        self.assertIn('<div class="logo-sub">Bring Your Own Books</div>', html)
        self.assertIn('<div class="audiobook-header-title" id="audiobookHeaderTitle">BYoB Audio</div>', html)
        self.assertNotIn("KuroYomi", html)
        self.assertNotIn("kuroyomi", html)

    def test_manifest_json_rebranding(self):
        manifest_path = os.path.join(server.PUBLIC_DIR, "manifest.json")
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        self.assertEqual(manifest.get("name"), "BYoB · Bring Your Own Books")
        self.assertEqual(manifest.get("short_name"), "BYoB")

    def test_service_worker_rebranding(self):
        sw_path = os.path.join(server.PUBLIC_DIR, "sw.js")
        with open(sw_path, "r", encoding="utf-8") as f:
            sw_content = f.read()

        self.assertIn("CACHE_NAME = 'byob-v30'", sw_content)
        self.assertIn("v=30.0", sw_content)

    def test_tts_js_engine_configuration(self):
        tts_path = os.path.join(server.PUBLIC_DIR, "js", "tts.js")
        with open(tts_path, "r", encoding="utf-8") as f:
            tts_code = f.read()

        self.assertIn("swapAudioBuffers()", tts_code)
        self.assertIn("prefetchAhead(fromIndex, count = 6)", tts_code)
        self.assertIn("prepareNextParagraph(nextIndex)", tts_code)
        self.assertIn("Welcome to BYoB. This is how I sound reading your books.", tts_code)
        self.assertIn("BYoB Audiobook", tts_code)

    def test_storage_backward_compatibility(self):
        storage_path = os.path.join(server.PUBLIC_DIR, "js", "storage.js")
        with open(storage_path, "r", encoding="utf-8") as f:
            storage_code = f.read()

        self.assertIn("DEVICE_TOKEN_KEY: 'byob_device_token'", storage_code)
        self.assertIn("LEGACY_DEVICE_TOKEN_KEY: 'kuroyomi_device_token'", storage_code)
        self.assertIn("SYNC_KEY_KEY: 'byob_sync_key'", storage_code)
        self.assertIn("LEGACY_SYNC_KEY_KEY: 'kuroyomi_sync_key'", storage_code)
        self.assertIn("USER_ID_KEY: 'byob_user_id'", storage_code)
        self.assertIn("LEGACY_USER_ID_KEY: 'kuroyomi_user_id'", storage_code)

    def test_icons_exist_and_valid(self):
        for icon_name in ("icon-192.png", "icon-512.png", "apple-touch-icon.png"):
            icon_path = os.path.join(server.PUBLIC_DIR, "icons", icon_name)
            self.assertTrue(os.path.exists(icon_path))
            self.assertGreater(os.path.getsize(icon_path), 500)

if __name__ == "__main__":
    unittest.main()
