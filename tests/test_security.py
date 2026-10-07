import io
import json
import os
import re
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
import zipfile

import database
import server
from html_sanitizer import sanitize_html


def make_epub(title, body_html):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{title}</dc:title><dc:creator>x</dc:creator></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>')
        z.writestr("OEBPS/c1.xhtml", f'<html><head><title>Chapter 1</title></head><body><h1>Chapter 1: Start</h1>{body_html}</body></html>')
    return buf.getvalue()


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        os.environ["READER_DB_PATH"] = os.path.join(cls.tmp, "security.db")
        database.init_db()
        cls.httpd = server.ThreadedHTTPServer(("127.0.0.1", 0), server.NovelReaderHandler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        server.RATE_LIMITER = server.RateLimiter()
        cls.a = cls.register("victim")
        cls.b = cls.register("attacker")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.RATE_LIMITER = server.RateLimiter()

    # ---- helpers
    @classmethod
    def call(cls, method, path, body=None, token=None, raw=None, headers=None):
        hdrs = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        if token:
            hdrs["X-Device-Token"] = token
        req = urllib.request.Request(cls.base + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                raw_body = resp.read()
                return resp.status, (json.loads(raw_body) if raw_body[:1] in (b"{", b"[") else raw_body), resp.headers
        except urllib.error.HTTPError as e:
            raw_body = e.read()
            return e.code, (json.loads(raw_body) if raw_body[:1] in (b"{", b"[") else raw_body), e.headers

    @classmethod
    def register(cls, name):
        token = "dev_" + uuid.uuid4().hex
        status, data, _ = cls.call("POST", "/api/auth/register-device", {"sync_key": "", "device_token": token, "device_name": name})
        assert status == 200 and data["success"], data
        return {"user": data["user_id"], "key": data["sync_key"], "token": token}

    @classmethod
    def upload(cls, user, token, epub_bytes, name="book.epub"):
        boundary = "----b" + uuid.uuid4().hex
        parts = [
            f'--{boundary}\r\nContent-Disposition: form-data; name="user_id"\r\n\r\n{user}\r\n'.encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\nContent-Type: application/epub+zip\r\n\r\n'.encode(),
            epub_bytes,
            f'\r\n--{boundary}--\r\n'.encode(),
        ]
        return cls.call("POST", "/api/upload", raw=b"".join(parts), token=token,
                        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def victim_book(self, body_html="<p>Hello there.</p>"):
        status, data, _ = self.upload(self.a["user"], self.a["token"], make_epub("Victim Book " + uuid.uuid4().hex[:6], body_html))
        self.assertEqual(status, 200, data)
        _, detail, _ = self.call("GET", f"/api/novels/{data['novel_id']}?user_id={self.a['user']}")
        return data["novel_id"], detail

    # ---- stored XSS
    def test_01_hostile_markup_is_stripped_by_the_sanitizer(self):
        hostile = {
            "handler without space": '<img src="x"onerror="alert(1)">',
            "svg slash handler": "<svg/onload=alert(1)></svg>",
            "entity encoded js": '<a href="&#106;avascript:alert(1)">x</a>',
            "tab inside scheme": '<a href="java\tscript:alert(1)">x</a>',
            "unquoted handler": "<img src=x onerror=alert(1)>",
            "details toggle": "<details open ontoggle=alert(1)>d</details>",
            "iframe": '<iframe src="javascript:alert(1)"></iframe>',
            "data html image": '<img src="data:text/html;base64,PHNjcmlwdD4=">',
            "nested script": "<scr<script>ipt>alert(1)</scr</script>ipt>",
        }
        for label, payload in hostile.items():
            out = sanitize_html(f"<p>{payload}</p>").lower()
            self.assertNotRegex(out, r"on\w+\s*=", label)
            self.assertNotIn("javascript:", out, label)
            self.assertNotIn("<svg", out, label)
            self.assertNotIn("<iframe", out, label)
            self.assertNotIn("data:text/html", out, label)
            self.assertNotIn("<script", out, label)

    def test_02_sanitizer_keeps_what_the_reader_needs(self):
        html_in = ('<h1 class="reader-heading" data-pid="0" id="p-0">Title</h1>'
                   '<p class="reader-paragraph" data-pid="1" id="p-1">Tom &amp; Jerry &nbsp; <b>bold</b> <em>em</em><br/>next</p>'
                   '<img src="data:image/png;base64,iVBORw0KGgo=" class="reader-image" loading="lazy" />')
        out = sanitize_html(html_in)
        for needle in ('class="reader-heading"', 'data-pid="1"', 'id="p-1"', "Tom &amp; Jerry", "&nbsp;", "<b>bold</b>",
                       "<em>em</em>", "<br>", 'src="data:image/png;base64,iVBORw0KGgo="', 'loading="lazy"'):
            self.assertIn(needle, out)
        self.assertEqual(sanitize_html(out), out, "sanitizing twice must not change the result")

    def test_03_uploaded_chapter_is_clean_when_served(self):
        _, detail = self.victim_book('<p><img src="x"onerror="alert(1)">a</p><p><a href="&#106;avascript:alert(2)">b</a></p>')
        cid = detail["chapters"][0]["id"]
        _, ch, _ = self.call("GET", f"/api/chapters/{cid}")
        self.assertNotRegex(ch["content_html"].lower(), r"on\w+\s*=|javascript:")

    def test_04_content_already_stored_is_sanitized_on_the_way_out(self):
        novel_id, detail = self.victim_book()
        cid = detail["chapters"][0]["id"]
        conn = database.get_db()
        conn.execute("UPDATE chapters SET content_html = ? WHERE id = ?", ('<p>x</p><img src=x onerror=alert(1)><svg/onload=alert(2)>', cid))
        conn.commit()
        conn.close()
        _, ch, _ = self.call("GET", f"/api/chapters/{cid}")
        self.assertNotRegex(ch["content_html"].lower(), r"on\w+\s*=|<svg")

    # ---- authorization
    def test_10_upload_into_someone_elses_account_is_refused(self):
        epub = make_epub("Injected", "<p>hi</p>")
        status, _, _ = self.upload(self.a["user"], None, epub)
        self.assertEqual(status, 401)
        status, _, _ = self.upload(self.a["user"], self.b["token"], epub)
        self.assertEqual(status, 401)

    def test_11_backup_and_device_list_need_the_accounts_own_device(self):
        for path in ("/api/backup", "/api/devices"):
            q = f"{path}?user_id={self.a['user']}"
            self.assertEqual(self.call("GET", q)[0], 401, path)
            self.assertEqual(self.call("GET", q, token=self.b["token"])[0], 401, path)
            self.assertEqual(self.call("GET", q, token=self.a["token"])[0], 200, path)

    def test_12_cover_of_another_users_novel_cannot_be_replaced(self):
        novel_id, detail = self.victim_book()
        before = detail["novel"]["cover_data"]
        cover = "data:image/png;base64,iVBORw0KGgo="
        # attacker authenticates as themselves but targets the victim's novel
        status, data, _ = self.call("POST", "/api/novels/cover", {"novel_id": novel_id, "user_id": self.b["user"], "cover_data": cover}, token=self.b["token"])
        self.assertEqual(status, 200)
        self.assertFalse(data["updated"])
        # attacker claims to be the victim
        status, _, _ = self.call("POST", "/api/novels/cover", {"novel_id": novel_id, "user_id": self.a["user"], "cover_data": cover}, token=self.b["token"])
        self.assertEqual(status, 401)
        _, after, _ = self.call("GET", f"/api/novels/{novel_id}?user_id={self.a['user']}")
        self.assertEqual(after["novel"]["cover_data"], before)

    def test_13_cover_must_be_an_image_data_url(self):
        novel_id, _ = self.victim_book()
        for bad in ('x" onerror="alert(1)', "javascript:alert(1)", "data:text/html;base64,AAAA", "data:image/png;base64,AA\"AA"):
            status, _, _ = self.call("POST", "/api/novels/cover", {"novel_id": novel_id, "user_id": self.a["user"], "cover_data": bad}, token=self.a["token"])
            self.assertEqual(status, 400, bad)

    def test_14_delete_needs_the_owner(self):
        novel_id, _ = self.victim_book()
        self.assertEqual(self.call("POST", "/api/novels/delete", {"novel_id": novel_id, "user_id": self.a["user"]})[0], 401)
        self.assertEqual(self.call("GET", f"/api/novels/{novel_id}?user_id={self.a['user']}")[0], 200)
        self.assertEqual(self.call("POST", "/api/novels/delete", {"novel_id": novel_id, "user_id": self.a["user"]}, token=self.a["token"])[0], 200)
        self.assertEqual(self.call("GET", f"/api/novels/{novel_id}?user_id={self.a['user']}")[0], 404)

    def test_15_restore_and_unlink_need_the_owner_or_the_sync_key(self):
        backup = {"novels": [], "volumes": [], "chapters": [], "progress": []}
        self.assertEqual(self.call("POST", "/api/restore", {"user_id": self.a["user"], "backup_data": backup})[0], 401)
        self.assertEqual(self.call("POST", "/api/restore", {"user_id": self.a["user"], "backup_data": backup}, token=self.b["token"])[0], 401)
        self.assertEqual(self.call("POST", "/api/restore", {"user_id": self.a["user"], "sync_key": self.a["key"], "backup_data": backup})[0], 200)
        self.assertEqual(self.call("POST", "/api/devices/unlink", {"user_id": self.a["user"], "device_token": self.a["token"]}, token=self.b["token"])[0], 401)

    def test_16_new_accounts_can_still_be_created_by_restore_and_upload(self):
        """After a free-tier reset the server has no such user yet; recovery must keep working."""
        fresh_user = "usr_" + uuid.uuid4().hex[:12]
        status, _, _ = self.upload(fresh_user, None, make_epub("Fresh", "<p>hi</p>"))
        self.assertEqual(status, 200)

    # ---- information leaks
    def test_20_novel_detail_does_not_leak_the_owner_id(self):
        _, detail = self.victim_book()
        self.assertNotIn("user_id", detail["novel"])

    def test_21_last_read_never_falls_back_to_another_users_record(self):
        novel_id, detail = self.victim_book()
        cid, vid = detail["chapters"][0]["id"], detail["volumes"][0]["id"]
        self.assertEqual(self.call("POST", "/api/progress", {"user_id": "guest", "novel_id": novel_id, "chapter_id": cid, "volume_id": vid})[0], 200)
        stranger = self.register("stranger")
        _, data, _ = self.call("GET", f"/api/last-read?user_id={stranger['user']}")
        self.assertIsNone(data["last_read"])

    def test_22_errors_do_not_echo_internals(self):
        status, data, _ = self.call("POST", "/api/progress", {"user_id": self.a["user"], "novel_id": "n", "chapter_id": "c", "paragraph_index": "abc"})
        self.assertEqual(status, 400)
        self.assertNotIn("invalid literal", json.dumps(data))

    def test_23_security_headers_on_pages_and_api(self):
        for path in ("/", "/js/app.js", "/api/health"):
            _, _, headers = self.call("GET", path)
            self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff", path)
            self.assertEqual(headers.get("X-Frame-Options"), "SAMEORIGIN", path)
            self.assertIn("object-src 'none'", headers.get("Content-Security-Policy", ""), path)

    # ---- availability
    def test_30_a_rejected_save_does_not_wedge_the_database(self):
        status, data, _ = self.call("POST", "/api/progress", {"user_id": self.a["user"], "novel_id": "nov_does_not_exist", "chapter_id": "ch_nope"})
        self.assertEqual(status, 404)
        started = time.time()
        self.register("after-bad-save")  # used to block for 30s and then fail with "database is locked"
        self.assertLess(time.time() - started, 5)

    def test_31_progress_values_are_validated(self):
        novel_id, detail = self.victim_book()
        base = {"user_id": self.a["user"], "novel_id": novel_id, "chapter_id": detail["chapters"][0]["id"], "volume_id": detail["volumes"][0]["id"]}
        self.assertEqual(self.call("POST", "/api/progress", {**base, "scroll_percent": "NaN"})[0], 400)
        self.assertEqual(self.call("POST", "/api/progress", {**base, "scroll_percent": 5000, "paragraph_index": -9})[0], 200)
        _, d, _ = self.call("GET", f"/api/novels/{novel_id}?user_id={self.a['user']}")
        self.assertEqual((d["progress"]["scroll_percent"], d["progress"]["paragraph_index"]), (100.0, 0))

    def test_32_oversized_json_body_is_rejected(self):
        status, _, _ = self.call("POST", "/api/settings", raw=b'{"user_id":"x","pad":"' + b"a" * (2 * 1024 * 1024) + b'"}',
                                 headers={"Content-Type": "application/json"})
        self.assertEqual(status, 413)

    def test_33_account_creation_is_rate_limited(self):
        server.RATE_LIMITER = server.RateLimiter()
        codes = [self.call("POST", "/api/auth/register-device", {"sync_key": "", "device_token": "dev_" + uuid.uuid4().hex, "device_name": "x"})[0] for _ in range(server.RATE_LIMITS["register"] + 5)]
        self.assertEqual(codes[:server.RATE_LIMITS["register"]], [200] * server.RATE_LIMITS["register"])
        self.assertIn(429, codes[server.RATE_LIMITS["register"]:])
        server.RATE_LIMITER = server.RateLimiter()

    def test_34_tts_cache_cannot_grow_without_bound(self):
        cache = tempfile.mkdtemp()
        old = (server.TTS_CACHE_DIR, server._TTS_CACHE_MAX_BYTES, server._TTS_CACHE_TARGET_BYTES)
        try:
            server.TTS_CACHE_DIR, server._TTS_CACHE_MAX_BYTES, server._TTS_CACHE_TARGET_BYTES = cache, 1000, 400
            for i in range(10):
                path = os.path.join(cache, f"{i}.mp3")
                with open(path, "wb") as f:
                    f.write(b"x" * 200)
                os.utime(path, (1000 + i, 1000 + i))
            server.prune_tts_cache()
            remaining = sorted(os.listdir(cache))
            self.assertLessEqual(sum(os.path.getsize(os.path.join(cache, n)) for n in remaining), 400)
            self.assertIn("9.mp3", remaining)  # newest survive
            self.assertNotIn("0.mp3", remaining)
        finally:
            server.TTS_CACHE_DIR, server._TTS_CACHE_MAX_BYTES, server._TTS_CACHE_TARGET_BYTES = old

    def test_35_new_sync_keys_have_more_entropy(self):
        self.assertRegex(self.a["key"], r"^READER-[0-9A-F]{12}$")


if __name__ == "__main__":
    unittest.main()
