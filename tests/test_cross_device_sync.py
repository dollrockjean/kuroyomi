import unittest
import os
import json
import hashlib
import io
import time
import database
import server

class CrossDeviceSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.test_db = os.path.join(os.path.dirname(__file__), "test_cross_device_sync.db")
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

    def test_01_send_error_returns_clean_json_not_html(self):
        """Test that send_error returns JSON instead of Python's default HTML error page."""
        class MockWfile(io.BytesIO):
            pass

        class DummyHandler(server.NovelReaderHandler):
            def __init__(self):
                self.wfile = MockWfile()
                self._headers_buffer = []
                self.headers = {}
                self.command = "POST"
                self.request_version = "HTTP/1.1"

            def send_response(self, code, message=None):
                self.status_code = code

            def send_header(self, keyword, value):
                self._headers_buffer.append(f"{keyword}: {value}")

            def end_headers(self):
                pass

        handler = DummyHandler()
        handler.send_error(413, "Payload Too Large", "File exceeds 50MB limit")
        output = handler.wfile.getvalue().decode('utf-8')

        # Must be valid JSON, NOT <!DOCTYPE html>
        self.assertFalse(output.startswith("<!DOCTYPE"))
        data = json.loads(output)
        self.assertEqual(data.get("status"), 413)
        self.assertEqual(data.get("error"), "Payload Too Large")
        self.assertEqual(data.get("explain"), "File exceeds 50MB limit")

    def test_02_deterministic_user_id_across_devices(self):
        """Test that any device presenting the same Sync Key derives the identical deterministic user ID."""
        test_sync_key = "READER-TEST-SYNC-8888"
        expected_user_id = f"usr_{hashlib.sha256(test_sync_key.encode('utf-8')).hexdigest()[:12]}"

        class MockHandler:
            def __init__(self):
                self.sent_json = None
                self.sent_status = 200
                self.headers = {}
            def send_json(self, data, status=200):
                self.sent_json = data
                self.sent_status = status

        # Device 1 (e.g. MacBook) registers with key
        h1 = MockHandler()
        server.NovelReaderHandler.handle_api_post(h1, "/api/auth/register-device", {
            "sync_key": test_sync_key,
            "device_token": "macbook_token_111",
            "device_name": "MacBook Pro",
            "remember": True
        })
        self.assertTrue(h1.sent_json.get("success"))
        uid1 = h1.sent_json.get("user_id")
        self.assertEqual(uid1, expected_user_id)

        # Device 2 (e.g. iPhone) pairs with the same key
        h2 = MockHandler()
        server.NovelReaderHandler.handle_api_post(h2, "/api/auth/register-device", {
            "sync_key": test_sync_key,
            "device_token": "iphone_token_222",
            "device_name": "iPhone 15 Pro",
            "remember": True
        })
        self.assertTrue(h2.sent_json.get("success"))
        uid2 = h2.sent_json.get("user_id")
        self.assertEqual(uid2, expected_user_id)
        self.assertEqual(uid1, uid2)

    def test_03_books_and_progress_shared_across_paired_devices(self):
        """Test that books uploaded by Device 1 are accessible to paired Device 2 with real-time progress syncing."""
        sync_key = "READER-SYNC-BOOKS-7777"
        uid = f"usr_{hashlib.sha256(sync_key.encode('utf-8')).hexdigest()[:12]}"
        database.ensure_user_exists(uid, sync_key)

        conn = database.get_db()
        cur = conn.cursor()
        now = time.time()
        novel_id = "nov_cross_device_sync_test"
        vol_id = "vol_cross_device_sync_test_1"
        ch1_id = "ch_cross_device_1"
        ch2_id = "ch_cross_device_2"

        cur.execute("""
            INSERT OR REPLACE INTO novels (id, title, author, description, user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (novel_id, "Cross-Device Synchronization Guide", "DeepMind Team", "A testing novel", uid, now, now))

        cur.execute("""
            INSERT OR REPLACE INTO volumes (id, novel_id, volume_number, title, file_name, total_chapters, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (vol_id, novel_id, 1, "Volume 1", "test.epub", 2, now))

        cur.execute("""
            INSERT OR REPLACE INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (ch1_id, novel_id, vol_id, 1, 1, "Chapter 1: The Protocol", "<p>Paragraph 1</p><p>Paragraph 2</p>", 4))

        cur.execute("""
            INSERT OR REPLACE INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (ch2_id, novel_id, vol_id, 2, 2, "Chapter 2: The Handshake", "<p>Paragraph 3</p><p>Paragraph 4</p>", 4))
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

        # Device 2 queries library
        h_lib = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_lib, "/api/novels", {"user_id": [uid]})
        novels = h_lib.sent_json.get("novels", [])
        matched = [n for n in novels if n["id"] == novel_id]
        self.assertEqual(len(matched), 1)

        # Device 1 reads up to Chapter 2, 60%
        h_prog1 = MockHandler()
        server.NovelReaderHandler.handle_api_post(h_prog1, "/api/progress", {
            "novel_id": novel_id,
            "volume_id": vol_id,
            "chapter_id": ch2_id,
            "paragraph_index": 1,
            "scroll_percent": 60.0,
            "user_id": uid
        })
        self.assertTrue(h_prog1.sent_json.get("success"))

        # Device 2 checks last-read
        h_last = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_last, "/api/last-read", {"user_id": [uid]})
        last_read = h_last.sent_json.get("last_read")
        self.assertIsNotNone(last_read)
        self.assertEqual(last_read.get("novel_id"), novel_id)
        self.assertEqual(last_read.get("chapter_id"), ch2_id)
        self.assertEqual(last_read.get("paragraph_index"), 1)

        # Device 2 scrolls back to Chapter 1, paragraph 0
        h_prog2 = MockHandler()
        server.NovelReaderHandler.handle_api_post(h_prog2, "/api/progress", {
            "novel_id": novel_id,
            "volume_id": vol_id,
            "chapter_id": ch1_id,
            "paragraph_index": 0,
            "scroll_percent": 15.0,
            "user_id": uid
        })
        self.assertTrue(h_prog2.sent_json.get("success"))

        # Device 1 queries progress on waking up: progress must reflect the backward read (Chapter 1)
        h_last2 = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_last2, "/api/last-read", {"user_id": [uid]})
        updated_read = h_last2.sent_json.get("last_read")
        self.assertEqual(updated_read.get("chapter_id"), ch1_id)
        self.assertEqual(updated_read.get("paragraph_index"), 0)

    def test_04_import_backup_reconciles_user_id_to_sync_key_owner(self):
        """Test that importing a backup with a sync key owner reconciles user_id into the deterministic owner."""
        sync_key = "READER-BACKUP-RECONCILE-999"
        expected_owner_id = f"usr_{hashlib.sha256(sync_key.encode('utf-8')).hexdigest()[:12]}"

        backup_payload = {
            "owner": {
                "id": "usr_temporary_random_id",
                "sync_key": sync_key,
                "device_name": "Temporary Client"
            },
            "novels": [{
                "id": "nov_reconciled_1",
                "title": "Reconciled Adventures",
                "author": "Antigravity",
                "description": "Test Reconcile",
                "cover_data": None
            }],
            "volumes": [{
                "id": "vol_reconciled_1",
                "novel_id": "nov_reconciled_1",
                "volume_number": 1,
                "title": "Vol 1",
                "file_name": "reconcile.epub",
                "total_chapters": 1
            }],
            "chapters": [{
                "id": "ch_reconciled_1",
                "novel_id": "nov_reconciled_1",
                "volume_id": "vol_reconciled_1",
                "chapter_index": 1,
                "global_index": 1,
                "title": "Chapter 1",
                "content_html": "<p>Content</p>",
                "word_count": 1
            }],
            "progress": [{
                "novel_id": "nov_reconciled_1",
                "volume_id": "vol_reconciled_1",
                "chapter_id": "ch_reconciled_1",
                "paragraph_index": 0,
                "scroll_percent": 25.0
            }],
            "settings": {}
        }

        # Import using any requested user_id; database must reconcile to expected_owner_id
        res = database.import_backup_data(backup_payload, "usr_temporary_random_id")
        self.assertEqual(res.get("novels_restored"), 1)

        # Confirm the novel is owned by expected_owner_id in the database
        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT title FROM novels WHERE user_id = ?", (expected_owner_id,))
        rows = [r["title"] for r in cur.fetchall()]
        conn.close()

        self.assertIn("Reconciled Adventures", rows)

    def test_05_unauthenticated_and_mirror_requests_do_not_leak_other_libraries(self):
        """Test that requesting /api/novels without user_id or with universal_device_mirror does not leak libraries."""
        class MockHandler:
            def __init__(self):
                self.sent_json = None
                self.sent_status = 200
                self.headers = {}
            def send_json(self, data, status=200):
                self.sent_json = data
                self.sent_status = status

        h_empty = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_empty, "/api/novels", {})
        self.assertEqual(h_empty.sent_json.get("novels"), [])

        h_mirror = MockHandler()
        server.NovelReaderHandler.handle_api_get(h_mirror, "/api/novels", {"user_id": ["universal_device_mirror"]})
        self.assertEqual(h_mirror.sent_json.get("novels"), [])

    def test_06_upload_size_limit_rejection(self):
        """Test that requests exceeding MAX_UPLOAD_SIZE are rejected with HTTP 413 JSON."""
        class MockWfile(io.BytesIO):
            pass

        class DummyHandler(server.NovelReaderHandler):
            def __init__(self):
                self.wfile = MockWfile()
                self._headers_buffer = []
                self.headers = {"Content-Length": str(60 * 1024 * 1024)}  # 60MB
                self.path = "/api/upload"
                self.command = "POST"
                self.request_version = "HTTP/1.1"
                self.status_code = 200

            def send_response(self, code, message=None):
                self.status_code = code

            def send_header(self, keyword, value):
                self._headers_buffer.append(f"{keyword}: {value}")

            def end_headers(self):
                pass

        handler = DummyHandler()
        handler.do_POST()
        output = handler.wfile.getvalue().decode('utf-8')
        self.assertFalse(output.startswith("<!DOCTYPE"))
        data = json.loads(output)
        self.assertEqual(handler.status_code, 413)
        self.assertIn("exceeds 50MB", data.get("error", ""))

if __name__ == "__main__":
    unittest.main()
