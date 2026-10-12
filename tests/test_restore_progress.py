import copy
import os
import time
import unittest

import database
import sample_books


class RestoreKeepsReadingPlaceTests(unittest.TestCase):
    """Restoring an old snapshot (after a free-tier server reset) must not roll a book back."""

    @classmethod
    def setUpClass(cls):
        cls.test_db = os.path.join(os.path.dirname(__file__), "test_restore_progress.db")
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(cls.test_db + suffix):
                os.remove(cls.test_db + suffix)
        database.DB_PATH = cls.test_db
        os.environ["READER_DB_PATH"] = cls.test_db
        database.init_db()

    @classmethod
    def tearDownClass(cls):
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(cls.test_db + suffix)
            except OSError:
                pass

    def _progress(self, user_id, novel_id):
        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM reading_progress WHERE user_id = ? AND novel_id = ?", (user_id, novel_id))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None

    def _chapters(self, novel_id):
        conn = database.get_db()
        cur = conn.cursor()
        cur.execute("SELECT id, volume_id FROM chapters WHERE novel_id = ? ORDER BY global_index ASC", (novel_id,))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

    def test_old_snapshot_does_not_overwrite_newer_server_position(self):
        user_id = database.get_or_create_user("READER-RESTORE-NEWER", "Restore Newer")
        novel_id = sample_books.seed_demo_novel(user_id)
        chapters = self._chapters(novel_id)
        self.assertGreaterEqual(len(chapters), 4)

        conn = database.get_db()
        conn.execute(
            "INSERT OR REPLACE INTO reading_progress (id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)",
            ("prog_new", user_id, novel_id, chapters[3]["volume_id"], chapters[3]["id"], time.time() - 5),
        )
        conn.commit()
        conn.close()

        backup = database.export_backup_data(user_id)
        stale = copy.deepcopy(backup)
        for p in stale["progress"]:
            p["chapter_id"] = chapters[1]["id"]
            p["updated_at"] = time.time() - 3600

        database.import_backup_data(stale, user_id)
        self.assertEqual(self._progress(user_id, novel_id)["chapter_id"], chapters[3]["id"])

    def test_restore_keeps_original_save_time(self):
        user_id = database.get_or_create_user("READER-RESTORE-TIME", "Restore Time")
        novel_id = sample_books.seed_demo_novel(user_id)
        chapters = self._chapters(novel_id)
        backup = database.export_backup_data(user_id)

        conn = database.get_db()
        conn.execute("DELETE FROM reading_progress WHERE user_id = ?", (user_id,))
        conn.commit()
        conn.close()

        saved_at = time.time() - 7200
        for p in backup["progress"]:
            p["chapter_id"] = chapters[2]["id"]
            p["updated_at"] = saved_at
        database.import_backup_data(backup, user_id)

        row = self._progress(user_id, novel_id)
        self.assertEqual(row["chapter_id"], chapters[2]["id"])
        self.assertAlmostEqual(row["updated_at"], saved_at, delta=1)

    def test_newer_snapshot_still_restores(self):
        user_id = database.get_or_create_user("READER-RESTORE-FORWARD", "Restore Forward")
        novel_id = sample_books.seed_demo_novel(user_id)
        chapters = self._chapters(novel_id)
        backup = database.export_backup_data(user_id)
        for p in backup["progress"]:
            p["chapter_id"] = chapters[3]["id"]
            p["updated_at"] = time.time() + 5  # in the future: clamped to now, still newer than the seeded row
        database.import_backup_data(backup, user_id)
        self.assertEqual(self._progress(user_id, novel_id)["chapter_id"], chapters[3]["id"])


if __name__ == "__main__":
    unittest.main()
