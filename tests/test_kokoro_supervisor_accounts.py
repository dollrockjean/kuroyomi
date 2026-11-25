"""The PC voice has to reach every BYoB account Rocco reads on, not just the keeper's.

Found 2026-11-25: his iPhone sits on its own READER- account, the PC announced only under the keeper
account, so the phone was truthfully told "no PC" and read with Edge. The supervisor now also
announces under each extra reader key kept on the PC, and each announcement proves itself with that
account's own key, so the key lock on /api/tts/engine stays as strict as before.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'tools')))
import database
import kokoro_supervisor as ks

KEEPER_KEY = "READER-KEEPERTEST1"
PHONE_KEY = "READER-PHONETEST22"


class FakeResp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b"{}"


class SupervisorAccountsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data = os.path.join(self.tmp, "kokoro")
        os.makedirs(self.data)
        keeper_dir = os.path.join(self.tmp, "BYoB Backups", "keeper")
        os.makedirs(keeper_dir)
        with open(os.path.join(keeper_dir, "keeper.json"), "w") as fh:
            json.dump({"base_url": "https://byob.example", "user_id": ks.account_id_for_key(KEEPER_KEY),
                       "device_token": "dev_pc", "sync_key": KEEPER_KEY}, fh)
        self.home = mock.patch.object(ks, "HOME", self.tmp)
        self.home.start()

    def tearDown(self):
        self.home.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sup(self):
        s = ks.Supervisor(self.data, want_tunnel=False)
        s.tunnel_url = "https://x.trycloudflare.com"
        s.server_health = lambda timeout=4: {"device": "cuda", "version": "k"}
        return s

    def test_account_id_matches_the_server(self):
        db = os.path.join(self.tmp, "t.db")
        with mock.patch.dict(os.environ, {"READER_DB_PATH": db}):
            database.init_db()
            self.assertEqual(database.get_or_create_user(PHONE_KEY), ks.account_id_for_key(PHONE_KEY))
            self.assertEqual(database.get_or_create_user(PHONE_KEY.lower()), ks.account_id_for_key(PHONE_KEY))
            database.release_connections()

    def test_only_the_keeper_without_extra_keys(self):
        self.assertEqual(self.sup().accounts(), [(ks.account_id_for_key(KEEPER_KEY), KEEPER_KEY)])

    def test_phone_key_file_adds_the_phone_account(self):
        with open(os.path.join(self.data, "phone-reader-key.txt"), "w", encoding="utf-8") as fh:
            fh.write("\ufeff" + PHONE_KEY.lower() + "\n")
        with open(os.path.join(self.data, "reader-keys.txt"), "w") as fh:
            fh.write("# comment\n%s\n%s\nOFFLINE\n" % (PHONE_KEY, KEEPER_KEY))
        accts = self.sup().accounts()
        self.assertEqual(accts, [(ks.account_id_for_key(KEEPER_KEY), KEEPER_KEY),
                                 (ks.account_id_for_key(PHONE_KEY), PHONE_KEY)])

    def test_announce_and_withdraw_go_to_every_account_with_its_own_key(self):
        with open(os.path.join(self.data, "phone-reader-key.txt"), "w") as fh:
            fh.write(PHONE_KEY)
        sent = []

        def fake_open(req, timeout=0):
            sent.append(json.loads(req.data.decode("utf-8")))
            return FakeResp()
        s = self.sup()
        with mock.patch.object(ks.urllib.request, "urlopen", fake_open):
            self.assertTrue(s.announce())
            s.withdraw()
        self.assertEqual([(b["user_id"], b["sync_key"]) for b in sent[:2]],
                         [(ks.account_id_for_key(KEEPER_KEY), KEEPER_KEY),
                          (ks.account_id_for_key(PHONE_KEY), PHONE_KEY)])
        self.assertTrue(all(b["url"] for b in sent[:2]))
        self.assertEqual([b["url"] for b in sent[2:]], ["", ""])
        self.assertGreater(s.last_announce_ok, 0)

    def test_a_failing_reader_account_does_not_mark_the_keeper_down(self):
        with open(os.path.join(self.data, "phone-reader-key.txt"), "w") as fh:
            fh.write(PHONE_KEY)
        calls = []

        def fake_open(req, timeout=0):
            body = json.loads(req.data.decode("utf-8"))
            calls.append(body["user_id"])
            if body["sync_key"] == PHONE_KEY:
                raise ks.urllib.error.HTTPError(req.full_url, 403, "no", {}, None)
            return FakeResp()
        s = self.sup()
        with mock.patch.object(ks.urllib.request, "urlopen", fake_open), \
                mock.patch.object(ks, "log") as lg:
            self.assertTrue(s.announce())
        self.assertEqual(len(calls), 2)
        logged = " ".join(str(c.args) for c in lg.call_args_list)
        self.assertIn("reader account 1", logged)
        self.assertNotIn(PHONE_KEY, logged)


if __name__ == "__main__":
    unittest.main()
