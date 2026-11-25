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
import re
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

    def test_nobody_is_given_the_address_or_the_key(self):
        """Not the account owner, not a linked device, not a stranger: the address stays here."""
        database.register_device(self.user_id, "dev_known", "iPhone", "unittest", True)
        for who in (dict(sync_key=SYNC_KEY), dict(device_token="dev_known"),
                    dict(sync_key=SYNC_KEY, device_token="dev_known"),
                    dict(device_token="dev_not_linked"), dict()):
            k = ask_engines(self.user_id, **who)
            self.assertTrue(k["available"], who)
            self.assertFalse(k["direct"], who)
            self.assertIsNone(k["url"], who)
            self.assertIsNone(k["token"], who)

    def test_the_app_still_learns_the_pc_is_up(self):
        k = ask_engines(self.user_id)
        self.assertTrue(k["available"])
        self.assertEqual(k["device"], "cuda")
        self.assertEqual(k["device_name"], "BYoB Kokoro (PC)")
        self.assertEqual(k["realtime_factor"], 18.0)

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


class AnnouncingTests(unittest.TestCase):
    """Who may tell this server where the PC is."""

    def setUp(self):
        self.db = os.path.join(os.path.dirname(__file__), "kokoro_ann.db")
        if os.path.exists(self.db):
            os.remove(self.db)
        database.DB_PATH = self.db
        database.init_db()
        self.user_id = database.get_or_create_user(SYNC_KEY)
        self.old_key = server.KOKORO_KEY

    def tearDown(self):
        server.KOKORO_KEY = self.old_key
        server.kokoro_set(self.user_id, None)
        if os.path.exists(self.db):
            try:
                os.remove(self.db)
            except OSError:
                pass

    def announce(self, key=None, sync_key=None):
        body = dict(user_id=self.user_id, url=TUNNEL, token="pc-token", device="cuda")
        if sync_key:
            body["sync_key"] = sync_key
        h = handler_for("/api/tts/engine", "POST", json.dumps(body).encode("utf-8"),
                        headers={"X-Kokoro-Key": key} if key else None)
        h.do_POST()
        return h.sent_status, json.loads(h.wfile.getvalue().decode("utf-8"))

    def test_the_key_lets_the_pc_announce(self):
        server.KOKORO_KEY = "shared-key"
        status, res = self.announce(key="shared-key")
        self.assertTrue(res.get("registered"))
        self.assertEqual(server.kokoro_get(self.user_id)["url"], TUNNEL)

    def test_no_key_is_refused_with_401(self):
        server.KOKORO_KEY = "shared-key"
        status, res = self.announce()
        self.assertEqual(status, 401)
        self.assertIsNone(server.kokoro_get(self.user_id))

    def test_a_wrong_key_is_refused_with_401(self):
        server.KOKORO_KEY = "shared-key"
        status, _ = self.announce(key="not-the-key")
        self.assertEqual(status, 401)

    def test_without_a_key_set_it_falls_back_to_owning_the_account(self):
        server.KOKORO_KEY = ""
        status, _ = self.announce()
        self.assertEqual(status, 403)
        status, res = self.announce(sync_key=SYNC_KEY)
        self.assertTrue(res.get("registered"))

    def test_owning_the_account_is_enough_even_when_a_key_is_set(self):
        """Nothing has to be configured by hand, and a mistyped KOKORO_KEY cannot lock the PC out."""
        server.KOKORO_KEY = "shared-key"
        status, res = self.announce(sync_key=SYNC_KEY)
        self.assertTrue(res.get("registered"), (status, res))
        self.assertEqual(server.kokoro_get(self.user_id)["url"], TUNNEL)

    def test_an_announcement_with_no_key_anywhere_is_refused(self):
        """A PC the server cannot unlock would show up as a voice that answers 401 to everything."""
        server.KOKORO_KEY = ""
        body = dict(user_id=self.user_id, url=TUNNEL, sync_key=SYNC_KEY, device="cuda")
        h = handler_for("/api/tts/engine", "POST", json.dumps(body).encode("utf-8"))
        h.do_POST()
        self.assertEqual(h.sent_status, 401)
        self.assertIsNone(server.kokoro_get(self.user_id))


class RelayKeyTests(unittest.TestCase):
    """Which key this server presents to the PC. The PC announces its own, so Rocco never has to
    put one in Render's dashboard; KOKORO_KEY only fills in when an announcement carries none."""

    def setUp(self):
        self.old_key = server.KOKORO_KEY

    def tearDown(self):
        server.KOKORO_KEY = self.old_key

    def test_the_announced_key_is_used(self):
        server.KOKORO_KEY = ""
        self.assertEqual(server.kokoro_request_key({"token": "pc-token"}), "pc-token")

    def test_the_announced_key_wins_over_a_stale_environment_one(self):
        server.KOKORO_KEY = "an-old-value"
        self.assertEqual(server.kokoro_request_key({"token": "pc-token"}), "pc-token")

    def test_the_environment_key_fills_in_when_none_was_announced(self):
        server.KOKORO_KEY = "shared-key"
        self.assertEqual(server.kokoro_request_key({"token": ""}), "shared-key")
        self.assertEqual(server.kokoro_request_key(None), "shared-key")

    def test_no_key_anywhere_means_an_empty_key(self):
        server.KOKORO_KEY = ""
        self.assertEqual(server.kokoro_request_key({}), "")


class PlayerContractTests(unittest.TestCase):
    """The app's side of the same deal, checked against the file the phone actually loads."""

    @classmethod
    def setUpClass(cls):
        p = os.path.join(os.path.dirname(__file__), "..", "public", "js", "tts.js")
        with open(p, encoding="utf-8") as fh:
            cls.js = fh.read()

    def test_the_player_never_holds_the_address_or_the_key(self):
        for forbidden in ("this.kokoro.url", "this.kokoro.token", "X-BYoB-Token",
                          "trycloudflare", "sync_key="):
            self.assertNotIn(forbidden, self.js, forbidden)

    def test_every_kokoro_request_goes_through_the_byob_server(self):
        self.assertIn("/api/tts/speak?engine=kokoro", self.js)
        self.assertIn("'/api/tts/prefetch'", self.js)

    def test_kokoro_is_usable_on_availability_alone(self):
        self.assertIn("return !!(this.kokoro && Date.now() > this._kokoroColdUntil)", self.js)


class ServerFileContractTests(unittest.TestCase):
    """What the PC's voice server exposes, read from the file that runs on the PC."""

    @classmethod
    def setUpClass(cls):
        p = os.path.join(os.path.dirname(__file__), "..", "tools", "kokoro_server.py")
        with open(p, encoding="utf-8") as fh:
            cls.py = fh.read()

    def test_it_is_bound_to_loopback_only(self):
        self.assertIn('HOST = "127.0.0.1"', self.py)
        self.assertIn("ThreadingHTTPServer((HOST, args.port)", self.py)
        self.assertNotIn('ap.add_argument("--host"', self.py)

    def test_the_key_comes_from_the_header_only(self):
        self.assertIn('self.headers.get("X-BYoB-Token") or ""', self.py)
        self.assertNotIn('query.get("token"', self.py)
        self.assertIn("hmac.compare_digest", self.py)

    def test_only_the_speech_routes_exist(self):
        routes = set(re.findall(r'path (?:==|!=|in|not in) \(?((?:"/[a-z]*",? ?)+)\)?', self.py))
        found = set(re.findall(r'"(/[a-z]*)"', " ".join(routes)))
        self.assertEqual(found, {"/", "/health", "/voices", "/tts", "/prefetch"})

    def test_every_route_is_guarded_and_limited(self):
        self.assertIn("if not self.guard(", self.py)
        self.assertIn('self.send_json({"error": "a key is required"}, status=401)', self.py)
        self.assertIn('self.send_json({"error": "too many requests"}, status=429)', self.py)

    def test_there_is_no_file_shell_or_admin_route(self):
        for forbidden in ("subprocess", "os.system", "SimpleHTTPRequestHandler", "eval(", "exec(",
                          "translate_path", "shutil.rmtree", "os.remove(self.path"):
            self.assertNotIn(forbidden, self.py, forbidden)


class RateLimitTests(unittest.TestCase):
    def test_the_ceiling_closes_and_reopens(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "kokoro_server_rl",
            os.path.join(os.path.dirname(__file__), "..", "tools", "kokoro_server.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        rl = mod.RateLimit()
        rl.PER_MINUTE = dict(rl.PER_MINUTE, **{"/tts": 3})
        self.assertTrue(all(rl.allow("/tts") for _ in range(3)))
        self.assertFalse(rl.allow("/tts"))
        self.assertEqual(rl.rejected, 1)
        self.assertTrue(rl.allow("/voices"))      # a different route has its own ceiling
        rl.hits["/tts"].clear()                   # what the minute passing looks like
        self.assertTrue(rl.allow("/tts"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
