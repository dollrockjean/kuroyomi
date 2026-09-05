import unittest
import threading
import time
import urllib.request
import urllib.parse
import json
import os
import sys

# Ensure project modules can be imported
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import database
import server
import epub_parser
sys.path.append('/Users/rdoll/.gemini/antigravity/brain/c58f8699-3179-46c5-bf49-351707dccd79/scratch')
from test_epub import create_sample_epub

TEST_PORT = 8912
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"

class NovelReaderIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Set clean test database
        cls.db_path = os.path.join(os.path.dirname(__file__), "test_reader.db")
        if os.path.exists(cls.db_path):
            os.remove(cls.db_path)
        os.environ["READER_DB_PATH"] = cls.db_path
        database.init_db()

        # Start server in background thread
        cls.server_thread = threading.Thread(target=server.run, args=(TEST_PORT,), daemon=True)
        cls.server_thread.start()
        time.sleep(0.5)

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.db_path):
            try:
                os.remove(cls.db_path)
            except Exception:
                pass

    def test_01_device_registration_and_remember_me(self):
        """Test 'Remember This Device' persistent session restoration on iOS/Web."""
        sync_key = "TEST-KEY-7777"
        device_token = "ios_token_12345"
        device_name = "iPhone 15 Pro (Safari)"

        # 1. Register device with remember=True
        req_data = json.dumps({
            "sync_key": sync_key,
            "device_token": device_token,
            "device_name": device_name,
            "remember": True
        }).encode('utf-8')

        req = urllib.request.Request(
            f"{BASE_URL}/api/auth/register-device",
            data=req_data,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data.get("success"))
            self.assertEqual(data.get("sync_key"), sync_key)
            self.assertEqual(data.get("device_token"), device_token)
            user_id = data.get("user_id")

        # 2. Check session recovery via device token alone
        with urllib.request.urlopen(f"{BASE_URL}/api/auth/device-session?device_token={device_token}") as resp:
            session_data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(session_data.get("authenticated"))
            self.assertEqual(session_data.get("user_id"), user_id)
            self.assertEqual(session_data.get("sync_key"), sync_key)
            self.assertEqual(session_data.get("device_name"), device_name)

        # 3. Query paired devices list
        with urllib.request.urlopen(f"{BASE_URL}/api/devices?user_id={user_id}") as resp:
            dev_data = json.loads(resp.read().decode('utf-8'))
            devices = dev_data.get("devices", [])
            self.assertGreaterEqual(len(devices), 1)
            self.assertEqual(devices[0]["device_name"], device_name)

    def test_02_novels_listing_and_auto_seed(self):
        """Test novel library loading and automatic demo novel seeding."""
        user_id = "test_user_reader"
        # Novel list automatically seeds the multi-volume demo novel if user has none
        with urllib.request.urlopen(f"{BASE_URL}/api/novels?user_id={user_id}") as resp:
            data = json.loads(resp.read().decode('utf-8'))
            novels = data.get("novels", [])
            self.assertEqual(len(novels), 1)
            novel = novels[0]
            self.assertEqual(novel["title"], "Chronicles of the Aether Sovereign")
            self.assertEqual(novel["volume_count"], 2)
            self.assertEqual(novel["total_chapters"], 10)

    def test_03_reading_progress_saving_and_resumption(self):
        """Test exact chapter, paragraph, and scroll percentage saving and instant retrieval."""
        user_id = "test_user_reader"
        # Get novel details to find a chapter ID
        with urllib.request.urlopen(f"{BASE_URL}/api/novels?user_id={user_id}") as resp:
            novel_id = json.loads(resp.read().decode('utf-8'))["novels"][0]["id"]

        with urllib.request.urlopen(f"{BASE_URL}/api/novels/{novel_id}?user_id={user_id}") as resp:
            novel_details = json.loads(resp.read().decode('utf-8'))
            vol_id = novel_details["volumes"][0]["id"]
            ch_id = novel_details["chapters"][2]["id"] # Chapter 3
            ch_title = novel_details["chapters"][2]["title"]

        # Save progress at paragraph 5, 58.2% scroll
        prog_data = json.dumps({
            "user_id": user_id,
            "novel_id": novel_id,
            "volume_id": vol_id,
            "chapter_id": ch_id,
            "paragraph_index": 5,
            "scroll_percent": 58.2
        }).encode('utf-8')

        req = urllib.request.Request(
            f"{BASE_URL}/api/progress",
            data=prog_data,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data.get("success"))

        # Fetch last-read for the resume hero banner
        with urllib.request.urlopen(f"{BASE_URL}/api/last-read?user_id={user_id}") as resp:
            last_read = json.loads(resp.read().decode('utf-8'))["last_read"]
            self.assertIsNotNone(last_read)
            self.assertEqual(last_read["novel_id"], novel_id)
            self.assertEqual(last_read["chapter_id"], ch_id)
            self.assertEqual(last_read["paragraph_index"], 5)
            self.assertAlmostEqual(last_read["scroll_percent"], 58.2, places=1)
            self.assertEqual(last_read["chapter_title"], ch_title)

    def test_04_user_settings_sync(self):
        """Test cloud syncing of themes, typography, and reader preferences."""
        user_id = "test_user_reader"
        settings_payload = json.dumps({
            "user_id": user_id,
            "theme": "cyber-terminal",
            "font_family": "dyslexic",
            "font_size": 22,
            "line_height": 1.9,
            "content_width": "wide",
            "auto_scroll_speed": 45,
            "tts_voice": "Daniel (Enhanced)",
            "tts_rate": 1.25,
            "tts_pitch": 1.05
        }).encode('utf-8')

        req = urllib.request.Request(
            f"{BASE_URL}/api/settings",
            data=settings_payload,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            self.assertTrue(json.loads(resp.read().decode('utf-8')).get("success"))

        with urllib.request.urlopen(f"{BASE_URL}/api/settings?user_id={user_id}") as resp:
            data = json.loads(resp.read().decode('utf-8'))["settings"]
            self.assertEqual(data["theme"], "cyber-terminal")
            self.assertEqual(data["font_family"], "dyslexic")
            self.assertEqual(data["font_size"], 22)
            self.assertEqual(data["auto_scroll_speed"], 45)
            self.assertEqual(data["tts_voice"], "Daniel (Enhanced)")

    def test_05_multipart_epub_upload_and_multi_volume_merging(self):
        """Test uploading multiple .epub files and merging them as volumes under one novel series."""
        user_id = "test_uploader"

        # Create two sample EPUB buffers
        epub1 = create_sample_epub(
            "Starfall Chronicles - Volume 1",
            "Seraphina Grey",
            [
                ("Chapter 1: The Comet", "<p>The sky burned like phosphorus.</p><p>Dust rained on the dome.</p>"),
                ("Chapter 2: The Core", "<p>Deep below the reactor, hummed the machine.</p>")
            ]
        )
        epub2 = create_sample_epub(
            "Starfall Chronicles - Volume 2",
            "Seraphina Grey",
            [
                ("Chapter 3: The Rebellion", "<p>Flags rose across the steel valley.</p>"),
                ("Chapter 4: The Starfall", "<p>The star fortress finally collapsed into light.</p>")
            ]
        )

        # Construct multipart/form-data request body
        boundary = "----TestBoundary12345"
        body = bytearray()

        def add_field(name, value):
            body.extend(f"--{boundary}\r\n".encode('utf-8'))
            body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode('utf-8'))
            body.extend(f"{value}\r\n".encode('utf-8'))

        def add_file(name, filename, data):
            body.extend(f"--{boundary}\r\n".encode('utf-8'))
            body.extend(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode('utf-8'))
            body.extend(b"Content-Type: application/epub+zip\r\n\r\n")
            body.extend(data)
            body.extend(b"\r\n")

        add_field("user_id", user_id)
        add_field("series_title", "Starfall Chronicles")
        add_file("files", "Starfall_Vol1.epub", epub1)
        add_file("files", "Starfall_Vol2.epub", epub2)
        body.extend(f"--{boundary}--\r\n".encode('utf-8'))

        req = urllib.request.Request(
            f"{BASE_URL}/api/upload",
            data=bytes(body),
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}
        )

        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data.get("success"))
            self.assertEqual(data.get("novel_title"), "Starfall Chronicles")
            self.assertEqual(data.get("volumes_added"), 2)
            self.assertEqual(data.get("chapters_added"), 4)
            novel_id = data.get("novel_id")

        # Verify novel details and sequential chapter indices
        with urllib.request.urlopen(f"{BASE_URL}/api/novels/{novel_id}?user_id={user_id}") as resp:
            novel_data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(len(novel_data["volumes"]), 2)
            self.assertEqual(len(novel_data["chapters"]), 4)

            # Check continuous global indexing 1, 2, 3, 4
            for idx, ch in enumerate(novel_data["chapters"], 1):
                self.assertEqual(ch["global_index"], idx)

    def test_06_auto_primary_device_sync(self):
        """Test that new/unpaired devices automatically link to the primary user library."""
        # Device A registers without any sync key
        req_a = urllib.request.Request(
            f"{BASE_URL}/api/auth/register-device",
            data=json.dumps({"sync_key": "", "device_name": "MacBook Air"}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req_a) as resp_a:
            data_a = json.loads(resp_a.read().decode('utf-8'))
            self.assertTrue(data_a.get("success"))
            primary_key = data_a.get("sync_key")
            user_id_a = data_a.get("user_id")
            self.assertTrue(primary_key)

        # Device B (iPhone) opens reader without any sync key
        req_b = urllib.request.Request(
            f"{BASE_URL}/api/auth/register-device",
            data=json.dumps({"sync_key": "", "device_name": "iPhone Safari"}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req_b) as resp_b:
            data_b = json.loads(resp_b.read().decode('utf-8'))
            self.assertTrue(data_b.get("success"))
            # Must automatically connect to Device A's primary library
            self.assertEqual(data_b.get("sync_key"), primary_key)
            self.assertEqual(data_b.get("user_id"), user_id_a)

if __name__ == "__main__":
    unittest.main()
