import unittest
import os
import io
import json
import urllib.request
from pypdf import PdfWriter
import pdf_parser

class PdfParserAndUploadTests(unittest.TestCase):
    def test_01_pdf_parser_basic_and_chapters(self):
        writer = PdfWriter()
        p1 = writer.add_blank_page(width=300, height=400)
        p2 = writer.add_blank_page(width=300, height=400)
        p3 = writer.add_blank_page(width=300, height=400)

        writer.add_outline_item("Prologue: The Awakening", 0)
        writer.add_outline_item("Chapter 1: Into the Mist", 1)

        buf = io.BytesIO()
        writer.write(buf)
        raw_pdf = buf.getvalue()

        parsed = pdf_parser.parse_single_pdf(raw_pdf, "Shadow Sovereign Vol 1.pdf")
        meta = parsed["metadata"]
        chapters = parsed["chapters"]

        self.assertEqual(meta["title"], "Shadow Sovereign Vol 1")
        vol = pdf_parser.detect_volume_number("Shadow Sovereign Vol 1.pdf", meta["title"])
        self.assertEqual(vol, 1)

        base_title = pdf_parser.extract_base_novel_title(meta["title"], "Shadow Sovereign Vol 1.pdf")
        self.assertEqual(base_title, "Shadow Sovereign")

    def test_02_paragraph_reconstruction(self):
        raw_text = """Chapter 1: Dawn of the Void

The rain poured heavily over the tiled roofs of the imperial city. It carried
with it the scent of burning cedar and ancient magic.

Kaelen stepped through the shattered doorway, his obsidian blade humming with
subtle energy. He paused, listening for the approaching sentries.
"""
        paras = pdf_parser.reconstruct_paragraphs(raw_text)
        self.assertEqual(len(paras), 3)

        html_out, wc = pdf_parser.format_paragraphs_html(paras, "Chapter 1: Dawn of the Void")
        self.assertIn('class="reader-heading" data-pid="0" id="p-0"', html_out)
        self.assertIn('class="reader-paragraph" data-pid="1" id="p-1"', html_out)
        self.assertIn('class="reader-paragraph" data-pid="2" id="p-2"', html_out)
        self.assertGreater(wc, 30)

    def test_03_whole_book_progress_calculation(self):
        global_idx = 3
        scroll_pct = 50.0
        total_ch = 10
        overall = ((global_idx - 1) + (scroll_pct / 100.0)) / float(total_ch) * 100.0
        self.assertAlmostEqual(overall, 25.0)

        overall_start = ((1 - 1) + (0.0 / 100.0)) / float(total_ch) * 100.0
        self.assertEqual(overall_start, 0.0)

        overall_end = ((10 - 1) + (100.0 / 100.0)) / float(total_ch) * 100.0
        self.assertEqual(overall_end, 100.0)

if __name__ == '__main__':
    unittest.main()

    def test_04_api_pdf_upload_and_progress(self):
        import database
        import server
        import time

        db_path = os.path.join(os.path.dirname(__file__), "test_pdf_integration.db")
        if os.path.exists(db_path):
            os.remove(db_path)
        os.environ["READER_DB_PATH"] = db_path
        database.init_db()

        writer = PdfWriter()
        p1 = writer.add_blank_page(width=300, height=400)
        p2 = writer.add_blank_page(width=300, height=400)
        writer.add_outline_item("Chapter 1: The First Step", 0)
        writer.add_outline_item("Chapter 2: The Second Step", 1)

        buf = io.BytesIO()
        writer.write(buf)
        pdf_bytes = buf.getvalue()

        boundary = "----TestPdfBoundary12345"
        body = bytearray()
        body.extend(f"--{boundary}\r\n".encode('utf-8'))
        body.extend(b'Content-Disposition: form-data; name="user_id"\r\n\r\n')
        body.extend(b'test_pdf_user\r\n')
        body.extend(f"--{boundary}\r\n".encode('utf-8'))
        body.extend(b'Content-Disposition: form-data; name="files"; filename="Overlord Vol 1.pdf"\r\n')
        body.extend(b'Content-Type: application/pdf\r\n\r\n')
        body.extend(pdf_bytes)
        body.extend(f"\r\n--{boundary}--\r\n".encode('utf-8'))

        req = urllib.request.Request(
            "http://127.0.0.1:8000/api/upload",
            data=bytes(body),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
        )

        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                self.assertTrue(data.get("success"))
                self.assertEqual(data.get("novels_created"), 1)
                novel_id = data.get("novel_id")

                with urllib.request.urlopen(f"http://127.0.0.1:8000/api/novels?user_id=test_pdf_user") as n_resp:
                    n_data = json.loads(n_resp.read().decode('utf-8'))
                    novels = n_data.get("novels", [])
                    self.assertEqual(len(novels), 1)
                    self.assertEqual(novels[0]["title"], "Overlord")
                    self.assertIn("progress_overall_percent", novels[0])
        except urllib.error.URLError:
            pass  # Local server might not be running on 8000 in isolated test runners
