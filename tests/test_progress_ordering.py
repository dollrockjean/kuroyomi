import unittest
import os
import database
import server
import sample_books


class MockHandler:
    def __init__(self):
        self.sent_json = None
        self.sent_status = 200
        self.headers = {}

    def send_json(self, data, status=200):
        self.sent_json = data
        self.sent_status = status


class ProgressOrderingTests(unittest.TestCase):
    """A save that reaches the server after a newer one from the same device must not win."""

    @classmethod
    def setUpClass(cls):
        cls.test_db = os.path.join(os.path.dirname(__file__), "test_progress_ordering.db")
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(cls.test_db + suffix):
                os.remove(cls.test_db + suffix)
        database.DB_PATH = cls.test_db
        os.environ["READER_DB_PATH"] = cls.test_db
        database.init_db()
        cls.user_id = database.get_or_create_user("READER-ORDERTEST", "Order Test")
        cls.novel_id = sample_books.seed_demo_novel(cls.user_id)
        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT id, volume_id FROM chapters WHERE novel_id = ? ORDER BY global_index ASC", (cls.novel_id,))
        cls.chapters = [dict(r) for r in cur.fetchall()]
        conn.close()

    @classmethod
    def tearDownClass(cls):
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(cls.test_db + suffix)
            except OSError:
                pass

    def save(self, chapter_idx, paragraph, percent, client_id=None, client_ts=None):
        ch = self.chapters[chapter_idx]
        body = {
            "user_id": self.user_id,
            "novel_id": self.novel_id,
            "volume_id": ch["volume_id"],
            "chapter_id": ch["id"],
            "paragraph_index": paragraph,
            "scroll_percent": percent,
        }
        if client_id is not None:
            body["client_id"] = client_id
            body["client_ts"] = client_ts
        h = MockHandler()
        server.NovelReaderHandler.handle_api_post(h, "/api/progress", body)
        self.assertTrue(h.sent_json.get("success"))
        return h.sent_json

    def stored(self):
        h = MockHandler()
        server.NovelReaderHandler.handle_api_get(h, f"/api/novels/{self.novel_id}", {"user_id": [self.user_id]})
        return h.sent_json["progress"]

    def test_01_stale_save_from_same_device_is_ignored(self):
        self.assertTrue(self.save(2, 8, 80.0, "cli_phone", 2000.0)["applied"])
        late = self.save(2, 1, 10.0, "cli_phone", 1000.0)  # older save arrives last (slow connection / queue replay)
        self.assertFalse(late["applied"])
        p = self.stored()
        self.assertEqual((p["paragraph_index"], p["scroll_percent"]), (8, 80.0))

    def test_02_newer_save_from_same_device_wins(self):
        self.save(3, 2, 20.0, "cli_phone", 3000.0)
        self.assertTrue(self.save(3, 9, 90.0, "cli_phone", 4000.0)["applied"])
        self.assertEqual(self.stored()["paragraph_index"], 9)

    def test_03_other_device_is_never_blocked_by_clock_differences(self):
        self.save(4, 5, 50.0, "cli_phone", 9_000_000.0)
        # A tablet whose clock runs far behind still takes over: the reader has moved to it
        self.assertTrue(self.save(4, 1, 5.0, "cli_tablet", 1.0)["applied"])
        self.assertEqual(self.stored()["paragraph_index"], 1)

    def test_04_saves_without_a_stamp_still_overwrite(self):
        """Older cached copies of the app send no stamp; they keep the old last-write-wins behaviour."""
        self.save(5, 4, 40.0, "cli_phone", 5000.0)
        self.assertTrue(self.save(5, 7, 70.0)["applied"])
        self.assertEqual(self.stored()["paragraph_index"], 7)

    def test_05_stamp_fields_are_not_exposed(self):
        self.save(6, 3, 30.0, "cli_phone", 6000.0)
        p = self.stored()
        self.assertNotIn("client_id", p)
        self.assertNotIn("client_ts", p)


if __name__ == "__main__":
    unittest.main()
