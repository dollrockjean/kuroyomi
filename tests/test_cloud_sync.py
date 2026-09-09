import unittest
import os
import json
import time
import urllib.request
import database
import server
import sample_books

class CloudSyncAndBridgingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.test_db = os.path.join(os.path.dirname(__file__), "test_cloud_sync.db")
        if os.path.exists(cls.test_db):
            os.remove(cls.test_db)
        database.DB_PATH = cls.test_db
        os.environ["READER_DB_PATH"] = cls.test_db
        database.init_db()

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.test_db):
            try:
                os.remove(cls.test_db)
            except Exception:
                pass

    def test_01_visitor_isolation_and_device_pairing(self):
        """Test that a new visitor without a sync key gets an isolated profile, while a pairing device connects to the owner."""
        # 1. Primary owner (e.g. Mac) uploads/seeds a book
        mac_user_id = database.get_or_create_user("READER-PRIMARY", "MacBook Pro")
        sample_books.seed_demo_novel(mac_user_id)

        class MockHandler:
            def __init__(self):
                self.sent_json = None
                self.sent_status = 200
                self.headers = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"}
            def send_json(self, data, status=200):
                self.sent_json = data
                self.sent_status = status

        # 2. Friend / first-time visitor opens plain link without any sync key
        h_friend = MockHandler()
        server.NovelReaderHandler.handle_api_post(h_friend, "/api/auth/register-device", {
            "sync_key": "",
            "device_token": "friend_token_xyz_99",
            "device_name": "Friend Phone Safari",
            "remember": True
        })

        self.assertTrue(h_friend.sent_json.get("success"))
        friend_user_id = h_friend.sent_json.get("user_id")
        friend_sync_key = h_friend.sent_json.get("sync_key")
        # Friend must have their OWN unique profile, NOT the owner's account
        self.assertNotEqual(friend_user_id, mac_user_id)
        self.assertNotEqual(friend_sync_key, "READER-PRIMARY")
        self.assertTrue(friend_sync_key.startswith("READER-"))

        # 3. Owner's second device connects using the owner's sync key (via 1-click link or manual pairing)
        h_owner_phone = MockHandler()
        server.NovelReaderHandler.handle_api_post(h_owner_phone, "/api/auth/register-device", {
            "sync_key": "READER-PRIMARY",
            "device_token": "owner_iphone_token_42",
            "device_name": "Owner iPhone",
            "remember": True
        })
        self.assertTrue(h_owner_phone.sent_json.get("success"))
        phone_user_id = h_owner_phone.sent_json.get("user_id")
        self.assertEqual(phone_user_id, mac_user_id)

        # 4. Query novels for the owner's phone
        h_novels = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_novels, "/api/novels", {"user_id": [phone_user_id]})
        novels = h_novels.sent_json.get("novels", [])
        self.assertGreaterEqual(len(novels), 1)
        self.assertEqual(novels[0]["title"], "Chronicles of the Aether Sovereign")

    def test_02_export_backup_data_fallback(self):
        """Test that export_backup_data falls back to primary library if given user has no books."""
        # Empty user queries backup
        backup = database.export_backup_data("usr_completely_empty_id")
        self.assertIn("novels", backup)
        self.assertGreaterEqual(len(backup["novels"]), 1)
        self.assertGreaterEqual(len(backup["chapters"]), 1)

    def test_03_import_backup_data_bridges_to_primary_user(self):
        """Test that restoring a backup automatically populates READER-PRIMARY."""
        test_user = "usr_mac_unique_uploader"
        database.ensure_user_exists(test_user)

        backup_data = {
            "novels": [{
                "id": "nov_cloud_sync_test",
                "title": "Cloud Sync Mastery",
                "author": "Antigravity",
                "description": "Cross-device sync without flaws",
                "cover_data": None
            }],
            "volumes": [{
                "id": "vol_cloud_sync_test_1",
                "novel_id": "nov_cloud_sync_test",
                "volume_number": 1,
                "title": "Volume 1",
                "file_name": "cloud_sync.epub",
                "total_chapters": 1
            }],
            "chapters": [{
                "id": "ch_cloud_sync_test_1",
                "novel_id": "nov_cloud_sync_test",
                "volume_id": "vol_cloud_sync_test_1",
                "chapter_index": 1,
                "global_index": 1,
                "title": "Chapter 1: The Zero-Flaw Sync",
                "content_html": "<p>Real-time cross-device sync active.</p>",
                "word_count": 6
            }],
            "progress": [{
                "novel_id": "nov_cloud_sync_test",
                "volume_id": "vol_cloud_sync_test_1",
                "chapter_id": "ch_cloud_sync_test_1",
                "paragraph_index": 0,
                "scroll_percent": 50.0
            }],
            "settings": {}
        }

        res = database.import_backup_data(backup_data, test_user)
        self.assertEqual(res.get("novels_restored"), 1)

        # Primary user must also have access to this novel
        primary_uid = database.get_or_create_user("READER-PRIMARY")
        class MockHandler:
            def __init__(self):
                self.sent_json = None
                self.sent_status = 200
            def send_json(self, data, status=200):
                self.sent_json = data
                self.sent_status = status

        h = MockHandler()
        server.NovelReaderHandler.handle_api_get(h, "/api/novels", {"user_id": [primary_uid]})
        novel_titles = [n["title"] for n in h.sent_json.get("novels", [])]
        self.assertIn("Cloud Sync Mastery", novel_titles)

    def test_04_cross_device_progress_continuity(self):
        """Test reading progress continuity across devices for newly linked devices."""
        class MockHandler:
            def __init__(self):
                self.sent_json = None
                self.sent_status = 200
            def send_json(self, data, status=200):
                self.sent_json = data
                self.sent_status = status

        h_last = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_last, "/api/last-read", {"user_id": ["universal_device_mirror"]})
        last_read = h_last.sent_json.get("last_read")
        self.assertIsNotNone(last_read)
        self.assertEqual(last_read["novel_title"], "Cloud Sync Mastery")
        self.assertEqual(last_read["scroll_percent"], 50.0)

if __name__ == "__main__":
    unittest.main()
