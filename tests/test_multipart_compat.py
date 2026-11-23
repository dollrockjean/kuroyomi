"""The stand-in multipart parser used when Python has no `cgi` module (3.13+)."""

import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import multipart_compat  # noqa: E402


def build(boundary, parts):
    """parts: list of (name, filename or None, bytes)."""
    out = io.BytesIO()
    for name, filename, data in parts:
        out.write(b"--" + boundary + b"\r\n")
        disp = 'form-data; name="%s"' % name
        if filename is not None:
            disp += '; filename="%s"' % filename
        out.write(b'Content-Disposition: ' + disp.encode() + b"\r\n")
        if filename is not None:
            out.write(b"Content-Type: application/epub+zip\r\n")
        out.write(b"\r\n")
        out.write(data)
        out.write(b"\r\n")
    out.write(b"--" + boundary + b"--\r\n")
    return out.getvalue()


def parse(body, boundary):
    return multipart_compat.parse_multipart(
        io.BytesIO(body), "multipart/form-data; boundary=" + boundary.decode(), len(body))


class MultipartCompatTest(unittest.TestCase):
    B = b"----BYoBTestBoundary1234"

    def test_plain_fields_and_one_file(self):
        body = build(self.B, [
            ("user_id", None, b"usr_abc123"),
            ("sync_key", None, b"k" * 40),
            ("files", "Volume 1.epub", b"PK\x03\x04fake-epub-bytes"),
        ])
        form = parse(body, self.B)
        self.assertEqual(form.getvalue("user_id"), "usr_abc123")
        self.assertEqual(form.getvalue("sync_key"), "k" * 40)
        self.assertIn("files", form)
        item = form["files"]
        self.assertEqual(item.filename, "Volume 1.epub")
        self.assertEqual(item.file.read(), b"PK\x03\x04fake-epub-bytes")

    def test_several_files_come_back_as_a_list(self):
        body = build(self.B, [
            ("user_id", None, b"usr_abc123"),
            ("files", "v1.epub", b"one"),
            ("files", "v2.epub", b"two"),
            ("files", "v3.epub", b"three"),
        ])
        form = parse(body, self.B)
        items = form["files"]
        self.assertEqual([i.filename for i in items], ["v1.epub", "v2.epub", "v3.epub"])
        self.assertEqual([i.file.read() for i in items], [b"one", b"two", b"three"])

    def test_missing_field_is_none(self):
        form = parse(build(self.B, [("user_id", None, b"u")]), self.B)
        self.assertIsNone(form.getvalue("novel_id"))
        self.assertNotIn("files", form)

    def test_binary_payload_survives_byte_for_byte(self):
        blob = bytes(range(256)) * 600  # 153 KB, every byte value, CRLFs included
        body = build(self.B, [("files", "b.epub", blob)])
        form = parse(body, self.B)
        self.assertEqual(form["files"].file.read(), blob)

    def test_payload_larger_than_the_read_chunk_and_spool(self):
        blob = os.urandom(3 * 1024 * 1024)  # spills to a real temp file
        body = build(self.B, [("user_id", None, b"u"), ("files", "big.epub", blob)])
        form = parse(body, self.B)
        self.assertEqual(form.getvalue("user_id"), "u")
        got = form["files"].file.read()
        self.assertEqual(len(got), len(blob))
        self.assertEqual(got, blob)

    def test_payload_containing_the_boundary_text(self):
        # A body that mentions the delimiter without the leading CRLF must not split early.
        blob = b"before--" + self.B + b"inline after"
        form = parse(build(self.B, [("files", "x.epub", blob)]), self.B)
        self.assertEqual(form["files"].file.read(), blob)

    def test_quoted_boundary_and_preamble(self):
        body = b"junk preamble\r\n" + build(self.B, [("user_id", None, b"u2")])
        form = multipart_compat.parse_multipart(
            io.BytesIO(body),
            'multipart/form-data; boundary="%s"' % self.B.decode(), len(body))
        self.assertEqual(form.getvalue("u" + "ser_id"), "u2")

    def test_no_boundary_raises(self):
        with self.assertRaises(ValueError):
            multipart_compat.parse_multipart(io.BytesIO(b""), "multipart/form-data", 0)

    def test_truncated_body_does_not_hang(self):
        full = build(self.B, [("user_id", None, b"u"), ("files", "t.epub", b"abcdefghij")])
        form = parse(full[:-12], self.B)
        self.assertEqual(form.getvalue("user_id"), "u")
        self.assertIn("files", form)

    def test_file_order_json_field(self):
        body = build(self.B, [("file_order", None, b'["v2.epub","v1.epub"]')])
        self.assertEqual(form_value(body, self.B), '["v2.epub","v1.epub"]')


def form_value(body, boundary):
    return parse(body, boundary).getvalue("file_order")


if __name__ == "__main__":
    unittest.main(verbosity=2)
