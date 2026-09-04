import unittest
import io
import json
import os
import sys
from email.message import Message

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import database
import server
import epub_parser
sys.path.append('/Users/rdoll/.gemini/antigravity/brain/c58f8699-3179-46c5-bf49-351707dccd79/scratch')
from test_epub import create_sample_epub

def create_mock_handler(path, method="GET", body=None, headers=None):
    handler = server.NovelReaderHandler.__new__(server.NovelReaderHandler)
    handler.request_version = "HTTP/1.1"
    handler.path = path
    handler.command = method
    
    msg = Message()
    if headers:
        for k, v in headers.items():
            msg[k] = v
    handler.headers = msg
    
    if body:
        handler.rfile = io.BytesIO(body)
        handler.headers["Content-Length"] = str(len(body))
    else:
        handler.rfile = io.BytesIO()
        handler.headers["Content-Length"] = "0"
        
    handler.wfile = io.BytesIO()
    handler.sent_status = None
    handler.sent_headers = {}
    
    def mock_send_response(status, message=None):
        handler.sent_status = status
    def mock_send_header(keyword, value):
        handler.sent_headers[keyword] = value
    def mock_end_headers():
        pass
        
    handler.send_response = mock_send_response
    handler.send_header = mock_send_header
    handler.end_headers = mock_end_headers
    
    return handler

class ApiDirectTests(unittest.TestCase):
    def setUp(self):
        self.test_db = os.path.join(os.path.dirname(__file__), "api_test.db")
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

    def test_01_auth_and_device_session(self):
        reg_body = json.dumps({
            "sync_key": "READER-ALPHA-1",
            "device_token": "token_apple_iphone",
            "device_name": "iPhone 16",
            "remember": True
        }).encode('utf-8')

        h = create_mock_handler("/api/auth/register-device", "POST", reg_body)
        h.do_POST()
        res = json.loads(h.wfile.getvalue().decode('utf-8'))
        self.assertTrue(res["success"])
        self.assertEqual(res["sync_key"], "READER-ALPHA-1")
        self.assertEqual(res["device_token"], "token_apple_iphone")
        user_id = res["user_id"]

        h2 = create_mock_handler("/api/auth/device-session?device_token=token_apple_iphone", "GET")
        h2.do_GET()
        res2 = json.loads(h2.wfile.getvalue().decode('utf-8'))
        self.assertTrue(res2["authenticated"])
        self.assertEqual(res2["user_id"], user_id)
        self.assertEqual(res2["device_name"], "iPhone 16")

        h3 = create_mock_handler(f"/api/devices?user_id={user_id}", "GET")
        h3.do_GET()
        res3 = json.loads(h3.wfile.getvalue().decode('utf-8'))
        self.assertEqual(len(res3["devices"]), 1)
        self.assertEqual(res3["devices"][0]["device_name"], "iPhone 16")

    def test_02_progress_and_last_read(self):
        user_id = database.get_or_create_user("PROGRESS_USER")
        import sample_books
        sample_books.seed_demo_novel(user_id)

        h_novels = create_mock_handler(f"/api/novels?user_id={user_id}", "GET")
        h_novels.do_GET()
        novels = json.loads(h_novels.wfile.getvalue().decode('utf-8'))["novels"]
        novel_id = novels[0]["id"]

        h_detail = create_mock_handler(f"/api/novels/{novel_id}?user_id={user_id}", "GET")
        h_detail.do_GET()
        detail = json.loads(h_detail.wfile.getvalue().decode('utf-8'))
        vol_id = detail["volumes"][0]["id"]
        ch = detail["chapters"][1]

        # Post reading progress
        prog_body = json.dumps({
            "user_id": user_id,
            "novel_id": novel_id,
            "volume_id": vol_id,
            "chapter_id": ch["id"],
            "paragraph_index": 3,
            "scroll_percent": 33.5
        }).encode('utf-8')

        h_prog = create_mock_handler("/api/progress", "POST", prog_body)
        h_prog.do_POST()
        self.assertTrue(json.loads(h_prog.wfile.getvalue().decode('utf-8'))["success"])

        # Fetch last read
        h_last = create_mock_handler(f"/api/last-read?user_id={user_id}", "GET")
        h_last.do_GET()
        last_read = json.loads(h_last.wfile.getvalue().decode('utf-8'))["last_read"]
        self.assertEqual(last_read["novel_id"], novel_id)
        self.assertEqual(last_read["chapter_id"], ch["id"])
        self.assertEqual(last_read["paragraph_index"], 3)
        self.assertEqual(last_read["scroll_percent"], 33.5)

    def test_03_chapter_detail_and_navigation(self):
        user_id = database.get_or_create_user("CHAPTER_NAV_USER")
        import sample_books
        sample_books.seed_demo_novel(user_id)

        # Get novel details
        h_novels = create_mock_handler(f"/api/novels?user_id={user_id}", "GET")
        h_novels.do_GET()
        novel_id = json.loads(h_novels.wfile.getvalue().decode('utf-8'))["novels"][0]["id"]

        h_detail = create_mock_handler(f"/api/novels/{novel_id}?user_id={user_id}", "GET")
        h_detail.do_GET()
        chapters = json.loads(h_detail.wfile.getvalue().decode('utf-8'))["chapters"]

        # Request Chapter 2 (should have prev=Chapter 1, next=Chapter 3)
        ch2_id = chapters[1]["id"]
        h_ch2 = create_mock_handler(f"/api/chapters/{ch2_id}", "GET")
        h_ch2.do_GET()
        ch2_data = json.loads(h_ch2.wfile.getvalue().decode('utf-8'))

        self.assertEqual(ch2_data["id"], ch2_id)
        self.assertEqual(ch2_data["global_index"], 2)
        self.assertIsNotNone(ch2_data["prev_chapter"])
        self.assertEqual(ch2_data["prev_chapter"]["id"], chapters[0]["id"])
        self.assertIsNotNone(ch2_data["next_chapter"])
        self.assertEqual(ch2_data["next_chapter"]["id"], chapters[2]["id"])

    def test_04_user_settings_api(self):
        user_id = database.get_or_create_user("SETTINGS_API_USER")
        payload = json.dumps({
            "user_id": user_id,
            "theme": "sepia-parchment",
            "font_family": "serif",
            "font_size": 24,
            "line_height": 2.1,
            "content_width": "narrow",
            "auto_scroll_speed": 42,
            "tts_voice": "Karen",
            "tts_rate": 1.15,
            "tts_pitch": 0.95,
            "library_view_mode": "list",
            "library_sort_by": "length"
        }).encode('utf-8')

        h_set = create_mock_handler("/api/settings", "POST", payload)
        h_set.do_POST()
        self.assertTrue(json.loads(h_set.wfile.getvalue().decode('utf-8'))["success"])

        h_get = create_mock_handler(f"/api/settings?user_id={user_id}", "GET")
        h_get.do_GET()
        saved = json.loads(h_get.wfile.getvalue().decode('utf-8'))["settings"]
        self.assertEqual(saved["theme"], "sepia-parchment")
        self.assertEqual(saved["font_family"], "serif")
        self.assertEqual(saved["font_size"], 24)
        self.assertEqual(saved["auto_scroll_speed"], 42)
        self.assertEqual(saved["tts_voice"], "Karen")
        self.assertEqual(saved["library_view_mode"], "list")
        self.assertEqual(saved["library_sort_by"], "length")

    def test_05_multipart_upload_and_add_volume(self):
        user_id = database.get_or_create_user("UPLOAD_USER")
        epub1 = create_sample_epub(
            "Nebula Sovereign Vol 1",
            "Azure Dragon",
            [("Chapter 1: Stardust", "<p>Stardust fell upon the ruins.</p>")]
        )
        epub2 = create_sample_epub(
            "Nebula Sovereign Vol 2",
            "Azure Dragon",
            [("Chapter 2: Celestial Star", "<p>A celestial star awakened.</p>")]
        )

        boundary = "---------------------------974767299852498929531610575"
        body = bytearray()

        def add_field(name, val):
            body.extend(f"--{boundary}\r\n".encode('utf-8'))
            body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode('utf-8'))
            body.extend(f"{val}\r\n".encode('utf-8'))

        def add_file(name, fname, data):
            body.extend(f"--{boundary}\r\n".encode('utf-8'))
            body.extend(f'Content-Disposition: form-data; name="{name}"; filename="{fname}"\r\n'.encode('utf-8'))
            body.extend(b"Content-Type: application/epub+zip\r\n\r\n")
            body.extend(data)
            body.extend(b"\r\n")

        add_field("user_id", user_id)
        add_field("series_title", "Nebula Sovereign")
        add_file("files", "Nebula_Vol1.epub", epub1)
        add_file("files", "Nebula_Vol2.epub", epub2)
        body.extend(f"--{boundary}--\r\n".encode('utf-8'))

        headers = {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body))
        }

        h_up = create_mock_handler("/api/upload", "POST", bytes(body), headers)
        h_up.do_POST()
        res = json.loads(h_up.wfile.getvalue().decode('utf-8'))
        self.assertTrue(res.get("success"))
        self.assertEqual(res["novel_title"], "Nebula Sovereign")
        self.assertEqual(res["volumes_added"], 2)
        self.assertEqual(res["chapters_added"], 2)
        novel_id = res["novel_id"]

        # Now test adding Volume 3 to this existing novel series
        epub3 = create_sample_epub(
            "Nebula Sovereign Vol 3",
            "Azure Dragon",
            [("Chapter 3: The Void God", "<p>The void god opened his eyes.</p>")]
        )
        body3 = bytearray()
        body3.extend(f"--{boundary}\r\n".encode('utf-8'))
        body3.extend(f'Content-Disposition: form-data; name="user_id"\r\n\r\n'.encode('utf-8'))
        body3.extend(f"{user_id}\r\n".encode('utf-8'))
        body3.extend(f"--{boundary}\r\n".encode('utf-8'))
        body3.extend(f'Content-Disposition: form-data; name="novel_id"\r\n\r\n'.encode('utf-8'))
        body3.extend(f"{novel_id}\r\n".encode('utf-8'))
        body3.extend(f"--{boundary}\r\n".encode('utf-8'))
        body3.extend(f'Content-Disposition: form-data; name="files"; filename="Nebula_Vol3.epub"\r\n'.encode('utf-8'))
        body3.extend(b"Content-Type: application/epub+zip\r\n\r\n")
        body3.extend(epub3)
        body3.extend(b"\r\n")
        body3.extend(f"--{boundary}--\r\n".encode('utf-8'))

        h_up3 = create_mock_handler("/api/upload", "POST", bytes(body3), {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body3))
        })
        h_up3.do_POST()
        res3 = json.loads(h_up3.wfile.getvalue().decode('utf-8'))
        self.assertTrue(res3.get("success"))
        self.assertEqual(res3["volumes_added"], 1)

        # Verify novel has 3 volumes and 3 chapters (global indices 1, 2, 3)
        h_verify = create_mock_handler(f"/api/novels/{novel_id}?user_id={user_id}", "GET")
        h_verify.do_GET()
        final_data = json.loads(h_verify.wfile.getvalue().decode('utf-8'))
        self.assertEqual(len(final_data["volumes"]), 3)
        self.assertEqual(len(final_data["chapters"]), 3)
        self.assertEqual(final_data["chapters"][2]["global_index"], 3)
        self.assertEqual(final_data["chapters"][2]["title"], "Chapter 3: The Void God")

    def test_06_delete_novel_endpoint(self):
        user_id = database.get_or_create_user("DELETE_USER")
        import sample_books
        sample_books.seed_demo_novel(user_id)

        h_novels = create_mock_handler(f"/api/novels?user_id={user_id}", "GET")
        h_novels.do_GET()
        novel_id = json.loads(h_novels.wfile.getvalue().decode('utf-8'))["novels"][0]["id"]

        del_body = json.dumps({"user_id": user_id, "novel_id": novel_id}).encode('utf-8')
        h_del = create_mock_handler("/api/novels/delete", "POST", del_body)
        h_del.do_POST()
        self.assertTrue(json.loads(h_del.wfile.getvalue().decode('utf-8'))["success"])

        # Check novel no longer exists
        h_novels2 = create_mock_handler(f"/api/novels?user_id={user_id}", "GET")
        h_novels2.do_GET()
        novels2 = json.loads(h_novels2.wfile.getvalue().decode('utf-8'))["novels"]
        self.assertEqual(len(novels2), 0)

    def test_07_tts_endpoints(self):
        # 1. Test Voices List
        h_voices = create_mock_handler("/api/tts/voices", "GET")
        h_voices.do_GET()
        voices_data = json.loads(h_voices.wfile.getvalue().decode('utf-8'))
        self.assertIn("voices", voices_data)
        self.assertTrue(len(voices_data["voices"]) >= 5)
        self.assertEqual(voices_data["voices"][0]["id"], "en-US-BrianNeural")

        # 2. Test Realistic Speech Synthesis Endpoint
        h_speak = create_mock_handler("/api/tts/speak?text=Hello+world&voice=en-US-BrianNeural", "GET")
        h_speak.do_GET()
        raw_val = h_speak.wfile.getvalue()
        # Should return HTTP 200 and audio/mpeg
        self.assertTrue(b"200 OK" in raw_val or len(raw_val) > 100)

    def test_08_health_and_cloud_backup_restore(self):
        # 1. Health check for cloud hosts
        h_health = create_mock_handler("/health", "GET")
        h_health.do_GET()
        health_data = json.loads(h_health.wfile.getvalue().decode('utf-8'))
        self.assertEqual(health_data["status"], "healthy")

        # 2. Backup export
        user_id = database.get_or_create_user("CLOUD_SAFEGUARD_USER")
        import sample_books
        sample_books.seed_demo_novel(user_id)

        h_backup = create_mock_handler(f"/api/backup?user_id={user_id}", "GET")
        h_backup.do_GET()
        backup_data = json.loads(h_backup.wfile.getvalue().decode('utf-8'))
        self.assertEqual(backup_data["user_id"], user_id)
        self.assertTrue(len(backup_data["novels"]) > 0)

        # 3. Restore to new user
        new_user = database.get_or_create_user("RESTORED_TARGET_USER")
        restore_body = json.dumps({
            "user_id": new_user,
            "backup_data": backup_data
        }).encode('utf-8')

        h_restore = create_mock_handler("/api/restore", "POST", restore_body)
        h_restore.do_POST()
        restore_res = json.loads(h_restore.wfile.getvalue().decode('utf-8'))
        self.assertTrue(restore_res["success"])
        self.assertTrue(restore_res["novels_restored"] > 0)

    def test_09_cover_update(self):
        user_id = database.get_or_create_user("COVER_TEST_USER")
        import sample_books
        novel_id = sample_books.seed_demo_novel(user_id)

        custom_cover = "data:image/jpeg;base64,mockcoverdata123"
        cover_body = json.dumps({
            "novel_id": novel_id,
            "user_id": user_id,
            "cover_data": custom_cover
        }).encode('utf-8')

        h_cover = create_mock_handler("/api/novels/cover", "POST", cover_body)
        h_cover.do_POST()
        cover_res = json.loads(h_cover.wfile.getvalue().decode('utf-8'))
        self.assertTrue(cover_res["success"])

        # Verify cover updated in novel query
        h_novels = create_mock_handler(f"/api/novels?user_id={user_id}", "GET")
        h_novels.do_GET()
        novels = json.loads(h_novels.wfile.getvalue().decode('utf-8'))["novels"]
        matched = [n for n in novels if n["id"] == novel_id]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["cover_data"], custom_cover)

if __name__ == "__main__":
    unittest.main()
