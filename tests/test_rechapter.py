import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


class RechapterTest(unittest.TestCase):
    def setUp(self):
        import database
        self.db = database
        self.tmp = tempfile.mkdtemp()
        self._old = os.environ.get('READER_DB_PATH')
        os.environ['READER_DB_PATH'] = os.path.join(self.tmp, 'test.db')
        database.init_db()
        conn = database.get_db()
        c = conn.cursor()
        now = time.time()
        c.execute("INSERT INTO users (id, sync_key, display_name, created_at, last_active) VALUES ('u1','BYOB-U1','u1',?,?)", (now, now))
        c.execute("INSERT INTO novels (id, title, user_id, created_at, updated_at) VALUES ('n1','Book','u1',?,?)", (now, now))
        c.execute("INSERT INTO volumes (id, novel_id, volume_number, title, file_name, total_chapters, created_at) VALUES ('v1','n1',1,'V1','b.epub',9,?)", (now,))
        pages = [
            ('c1', 'Chapter 1: Start', '<h2>Chapter 1: Start</h2><p data-pid="0">One two</p><p data-pid="1">three and</p>'),
            ('c2', 'Page 2', '<p data-pid="0">four five.</p><p data-pid="1">Six.</p>'),
            ('c3', 'Page 3', '<p data-pid="0">Seven.</p>'),
            ('c4', 'Chapter 2: Middle', '<h2>Chapter 2: Middle</h2><p data-pid="0">Eight.</p>'),
            ('c5', 'Page 5', '<h2>Chapter 2: Middle</h2><p data-pid="0">Nine.</p><p data-pid="1">Ten.</p>'),
            ('c6', 'Page 6', '<p data-pid="0">Eleven.</p>'),
            ('c7', 'Chapter 3: End', '<h2>Chapter 3: End</h2><p data-pid="0">Twelve.</p>'),
            ('c8', 'Page 8', '<p data-pid="0">Thirteen.</p>'),
            ('c9', 'Page 9', '<p data-pid="0">Fourteen.</p>'),
        ]
        for i, (cid, t, h) in enumerate(pages, start=1):
            c.execute("INSERT INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count) VALUES (?,?,?,?,?,?,?,?)",
                      (cid, 'n1', 'v1', i, i, t, h, 2))
        c.execute("INSERT INTO reading_progress (id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, updated_at) VALUES ('p1','u1','n1','v1','c5',1,0.5,?)", (now,))
        conn.commit()
        conn.close()

    def tearDown(self):
        if self._old is None:
            os.environ.pop('READER_DB_PATH', None)
        else:
            os.environ['READER_DB_PATH'] = self._old

    def test_merges_pages_and_moves_progress(self):
        res = self.db.rechapter_novel('n1', 'u1')
        self.assertTrue(res['success'])
        self.assertEqual(res['total_before'], 9)
        self.assertEqual(res['total_after'], 3)
        conn = self.db.get_db()
        rows = conn.execute("SELECT id, title, chapter_index, global_index, content_html FROM chapters WHERE novel_id='n1' ORDER BY global_index").fetchall()
        self.assertEqual([r['id'] for r in rows], ['c1', 'c4', 'c7'])
        self.assertEqual([r['global_index'] for r in rows], [1, 2, 3])
        # Sentence cut by the page break is joined back
        self.assertIn('three and four five.', rows[0]['content_html'])
        # Running header on page 5 dropped: only one Chapter 2 heading
        self.assertEqual(rows[1]['content_html'].count('Chapter 2: Middle'), 1)
        prog = conn.execute("SELECT chapter_id, paragraph_index FROM reading_progress WHERE id='p1'").fetchone()
        self.assertEqual(prog['chapter_id'], 'c4')
        # c4 has heading(0) + Eight(1); page 5 starts at 2, saved pid 1 -> 3 (the "Ten." line)
        self.assertEqual(prog['paragraph_index'], 3)
        self.assertIn('data-pid="3" id="p-3">Ten.', rows[1]['content_html'])
        vol = conn.execute("SELECT total_chapters FROM volumes WHERE id='v1'").fetchone()
        self.assertEqual(vol['total_chapters'], 3)
        conn.close()
        self.assertEqual(res['remap']['c5'], ['c4', 2])

    def test_second_run_is_noop_and_wrong_user_denied(self):
        self.db.rechapter_novel('n1', 'u1')
        res = self.db.rechapter_novel('n1', 'u1')
        self.assertEqual(res['merged'], 0)
        self.assertIn('error', self.db.rechapter_novel('n1', 'someone_else'))


if __name__ == '__main__':
    unittest.main()
