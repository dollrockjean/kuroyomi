"""The PC voice has to stay reachable from the phone after Render restarts.

Render's free plan keeps no disk, so reader.db is wiped whenever the service restarts. The PC
re-registers itself every minute, but the phone only registers its device when the page is loaded,
so for a while the phone holds a device token the server has never heard of. These tests pin down
what the phone is allowed to get in that state: the sync key alone proves it owns the account and
earns the direct address, and even with nothing to prove it, Kokoro still reads as available so the
app can go through the BYoB server instead of dropping to Edge. Found live on 2026-11-24.
"""
import io
import json
import os
import sys
import unittest
from email.message import Message

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import database
import server

SYNC_KEY = "READER-KOKORO-1"
TUNNEL = "https://example-quick-tunnel.trycloudflare.com"


def handler_for(path, method="GET", body=None, headers=None):
    h = server.NovelReaderHandler.__new__(server.NovelReaderHandler)
    h.request_version = "HTTP/1.1"
    h.path = path
    h.command = method
    msg = Message()
    for k, v in (headers or {}).items():
        msg[k] = v
    h.headers = msg
    h.rfile = io.BytesIO(body or b"")
    h.headers["Content-Length"] = str(len(body or b""))
    h.wfile = io.BytesIO()
    h.sent_status = None
    h.sent_headers = {}
    h.send_response = lambda status, message=None: setattr(h, "sent_status", status)
    h.send_header = lambda k, v: h.sent_headers.__setitem__(k, v)
    h.end_headers = lambda: None
    return h


def ask_engines(user_id, sync_key=None, device_token=None):
    path = "/api/tts/engines?user_id=" + user_id
    if sync_key:
        path += "&sync_key=" + sync_key
    h = handler_for(path, headers={"X-Device-Token": device_token} if device_token else None)
    h.do_GET()
    return json.loads(h.wfile.getvalue().decode("utf-8"))["engines"]["kokoro"]


class KokoroEngineTests(unittest.TestCase):
    def setUp(self):
        self.db = os.path.join(os.path.dirname(__file__), "kokoro_test.db")
        if os.path.exists(self.db):
            os.remove(self.db)
        database.DB_PATH = self.db
        database.init_db()
        self.user_id = database.get_or_create_user(SYNC_KEY)
        # The PC announces itself the way kokoro_supervisor.py does.
        server.kokoro_set(self.user_id, {
            "url": TUNNEL, "token": "secret-pc-token", "device": "cuda",
            "device_name": "BYoB Kokoro (PC)", "version": "kokoro-1.0", "realtime_factor": 18.0,
        })

    def tearDown(self):
        server.kokoro_set(self.user_id, None)
        if os.path.exists(self.db):
            try:
                os.remove(self.db)
            except OSError:
                pass

    def test_sync_key_alone_earns_the_direct_address(self):
        """What the phone sends after a wipe: a sync key, and a device token the server lost."""
        k = ask_engines(self.user_id, sync_key=SYNC_KEY, device_token="dev_the_server_forgot")
        self.assertTrue(k["available"])
        self.assertTrue(k["direct"])
        self.assertEqual(k["url"], TUNNEL)
        self.assertEqual(k["token"], "secret-pc-token")

    def test_known_device_earns_the_direct_address(self):
        database.register_device(self.user_id, "dev_known", "iPhone", "unittest", True)
        k = ask_engines(self.user_id, device_token="dev_known")
        self.assertTrue(k["direct"])
        self.assertEqual(k["url"], TUNNEL)

    def test_a_stranger_sees_kokoro_but_not_the_address(self):
        """Available so the app can use the server relay; no address, because it proved nothing."""
        k = ask_engines(self.user_id, device_token="dev_not_linked")
        self.assertTrue(k["available"])
        self.assertFalse(k["direct"])
        self.assertIsNone(k["url"])
        self.assertIsNone(k["token"])
        self.assertEqual(k["device"], "cuda")

    def test_a_wrong_sync_key_proves_nothing(self):
        k = ask_engines(self.user_id, sync_key="READER-SOMEONE-ELSE")
        self.assertTrue(k["available"])
        self.assertFalse(k["direct"])
        self.assertIsNone(k["url"])

    def test_the_pc_going_quiet_marks_kokoro_unavailable(self):
        server.kokoro_set(self.user_id, None)
        k = ask_engines(self.user_id, sync_key=SYNC_KEY)
        self.assertFalse(k["available"])
        self.assertNotIn("url", k)

    def test_a_stale_announcement_counts_as_gone(self):
        import time
        server._KOKORO_ENGINES[self.user_id]["announced_at"] = (
            time.time() - server.KOKORO_STALE_SECONDS - 5)
        k = ask_engines(self.user_id, sync_key=SYNC_KEY)
        self.assertFalse(k["available"])


class PlayerContractTests(unittest.TestCase):
    """The app's side of the same deal, checked against the file the phone actually loads."""

    @classmethod
    def setUpClass(cls):
        p = os.path.join(os.path.dirname(__file__), "..", "public", "js", "tts.js")
        with open(p, encoding="utf-8") as fh:
            cls.js = fh.read()

    def test_the_probe_sends_the_sync_key(self):
        self.assertIn("sync_key=${encodeURIComponent(syncKey)}", self.js)

    def test_kokoro_without_an_address_is_still_usable(self):
        self.assertIn("relay: !url", self.js)
        self.assertIn("(this.kokoro.url || this.kokoro.relay)", self.js)

    def test_the_relay_request_asks_for_kokoro(self):
        self.assertIn("/api/tts/speak?engine=kokoro", self.js)

    def test_the_direct_path_still_needs_an_address(self):
        self.assertIn("if (engine === 'kokoro' && this.kokoro.url)", self.js)


if __name__ == "__main__":
    unittest.main(verbosity=1)
