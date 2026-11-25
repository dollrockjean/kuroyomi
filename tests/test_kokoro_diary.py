"""The one thing nobody could look inside was the phone.

Two nights were spent on "his phone says the PC is unreachable" with the PC, the tunnel, the key
and the server all provably healthy, because nothing recorded what the phone asked for or what it
was told. The server now keeps a short diary of every engine question, every relayed paragraph and
every check-in from the PC, and the account owner - and only the account owner - can read it back
from /api/tts/diag (2026-11-25).

It also pins the second half of that fix: the app asks under the account id derived from its sync
key, the PC announces under the id in its own config file, and the voice is registered under both
so a drift between them can never make a healthy PC invisible.
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

SYNC_KEY = "READER-DIARY-1"
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


def answer_of(h):
    return json.loads(h.wfile.getvalue().decode("utf-8"))


class DiaryTests(unittest.TestCase):
    def setUp(self):
        self.db = os.path.join(os.path.dirname(__file__), "kokoro_diary.db")
        if os.path.exists(self.db):
            os.remove(self.db)
        database.DB_PATH = self.db
        database.init_db()
        self.user_id = database.get_or_create_user(SYNC_KEY)
        server._KOKORO_DIARY.clear()
        server.kokoro_set(self.user_id, {
            "url": TUNNEL, "token": "secret-pc-token", "device": "cuda",
            "device_name": "BYoB Kokoro (PC)", "version": "kokoro-1.1", "realtime_factor": 10.0,
        })

    def tearDown(self):
        server.kokoro_set(self.user_id, None)
        server._KOKORO_DIARY.clear()
        if os.path.exists(self.db):
            try:
                os.remove(self.db)
            except OSError:
                pass

    def ask_engines(self, build=""):
        path = "/api/tts/engines?user_id=" + self.user_id + ("&build=" + build if build else "")
        h = handler_for(path, headers={"User-Agent": "iPhone-test"})
        h.do_GET()
        return answer_of(h)["engines"]["kokoro"]

    def diag(self, sync_key=None, device_token=None):
        path = "/api/tts/diag?user_id=" + self.user_id
        if sync_key:
            path += "&sync_key=" + sync_key
        h = handler_for(path, headers={"X-Device-Token": device_token} if device_token else None)
        h.do_GET()
        return h.sent_status, answer_of(h)

    def test_the_build_the_phone_runs_is_written_down(self):
        self.ask_engines(build="55.1")
        status, res = self.diag(sync_key=SYNC_KEY)
        asked = [e for e in res["diary"] if e["what"] == "asked"]
        self.assertEqual(len(asked), 1)
        self.assertEqual(asked[0]["build"], "55.1")
        self.assertEqual(asked[0]["answer"], "up")
        self.assertIn("iPhone", asked[0]["agent"])

    def test_a_phone_told_there_is_no_pc_says_so_in_the_diary(self):
        server.kokoro_set(self.user_id, None)
        self.ask_engines(build="55.4")
        status, res = self.diag(sync_key=SYNC_KEY)
        self.assertEqual([e["answer"] for e in res["diary"] if e["what"] == "asked"], ["no PC"])
        self.assertFalse(res["pc"]["live"])

    def test_only_the_account_owner_may_read_it(self):
        self.ask_engines(build="55.4")
        database.register_device(self.user_id, "dev_known", "iPhone", "unittest", True)
        for who in (dict(), dict(sync_key="READER-WRONG"), dict(device_token="dev_not_linked")):
            status, res = self.diag(**who)
            self.assertEqual(status, 401, who)
            self.assertNotIn("diary", res, who)
        for who in (dict(sync_key=SYNC_KEY), dict(device_token="dev_known")):
            status, res = self.diag(**who)
            self.assertEqual(status, 200, who)
            self.assertIn("diary", res, who)

    def test_the_diary_never_holds_the_key_or_the_address(self):
        self.ask_engines(build="55.4")
        status, res = self.diag(sync_key=SYNC_KEY)
        blob = json.dumps(res)
        self.assertNotIn("secret-pc-token", blob)
        self.assertNotIn("trycloudflare", blob)
        self.assertTrue(res["pc"]["has_key"], "the server should still say it holds one")

    def test_another_account_sees_only_its_own_lines(self):
        self.ask_engines(build="55.4")
        other = database.get_or_create_user("READER-DIARY-2")
        database.register_device(other, "dev_other", "Other", "unittest", True)
        h = handler_for("/api/tts/diag?user_id=" + other,
                        headers={"X-Device-Token": "dev_other"})
        h.do_GET()
        self.assertEqual(answer_of(h)["diary"], [])

    def test_a_relayed_paragraph_records_which_voice_carried_it(self):
        server.kokoro_set(self.user_id, None)
        h = handler_for("/api/tts/speak?engine=kokoro&user_id=%s&text=hello" % self.user_id)
        try:
            h.do_GET()
        except Exception:
            pass          # Edge needs the network; the diary line is written before that
        status, res = self.diag(sync_key=SYNC_KEY)
        lines = [e for e in res["diary"] if e["what"] == "paragraph asked for the PC"]
        self.assertEqual([e["answer"] for e in lines], ["no PC"])


class AnnounceAliasTests(unittest.TestCase):
    """A PC announcing under one id must still be found by an app asking under the other."""

    def setUp(self):
        self.db = os.path.join(os.path.dirname(__file__), "kokoro_alias.db")
        if os.path.exists(self.db):
            os.remove(self.db)
        database.DB_PATH = self.db
        database.init_db()
        self.real = database.get_or_create_user(SYNC_KEY)
        self.stale = "usr_oldconfigid1"
        server._KOKORO_DIARY.clear()

    def tearDown(self):
        for uid in (self.real, self.stale):
            server.kokoro_set(uid, None)
        if os.path.exists(self.db):
            try:
                os.remove(self.db)
            except OSError:
                pass

    def test_the_voice_is_registered_under_the_account_the_sync_key_owns(self):
        body = json.dumps({"user_id": self.stale, "sync_key": SYNC_KEY, "url": TUNNEL,
                           "token": "pc-token", "device": "cuda"}).encode("utf-8")
        h = handler_for("/api/tts/engine", "POST", body)
        h.do_POST()
        self.assertTrue(answer_of(h).get("registered"))
        # The id the PC used, and the one the app would ask under, both find the voice.
        self.assertEqual(server.kokoro_get(self.stale)["url"], TUNNEL)
        self.assertEqual(server.kokoro_get(self.real)["url"], TUNNEL)

    def test_an_unknown_sync_key_adds_no_second_account(self):
        body = json.dumps({"user_id": self.stale, "sync_key": "READER-NOT-A-KEY", "url": TUNNEL,
                           "token": "pc-token", "device": "cuda"}).encode("utf-8")
        h = handler_for("/api/tts/engine", "POST", body)
        h.do_POST()
        self.assertIsNone(database.account_id_for_sync_key("READER-NOT-A-KEY"))
        self.assertEqual(server.kokoro_get(self.stale)["url"], TUNNEL)


if __name__ == "__main__":
    unittest.main()
