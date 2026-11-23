"""A small stand-in for cgi.FieldStorage, used only when the `cgi` module is gone.

Python 3.13 removed `cgi`, so on a newer Python the server could not even start (the live
Render container still runs 3.9 and uses the real `cgi`). This parses multipart/form-data
the same way the upload handler needs it:

    form = parse_multipart(rfile, content_type, content_length)
    form.getvalue("user_id")        -> str or None
    "files" in form                 -> bool
    form["files"]                   -> one field or a list of fields
    field.filename                  -> the uploaded name, or None for a plain value
    field.file.read()               -> the bytes

Each uploaded file spills to a temporary file past 1 MB, so a 100 MB book never sits in
memory twice; plain fields stay as text.
"""

import io
import re
import tempfile

__all__ = ["parse_multipart", "MultipartField", "MultipartForm"]

SPOOL_MAX_BYTES = 1024 * 1024
_READ_CHUNK = 64 * 1024


class MultipartField:
    """One part of the form: either a plain value or an uploaded file."""

    def __init__(self, name, filename, file_obj, content_type):
        self.name = name
        self.filename = filename or None
        self.file = file_obj
        self.type = content_type

    @property
    def value(self):
        """Bytes for a file, decoded text for a plain field (what cgi does)."""
        self.file.seek(0)
        raw = self.file.read()
        self.file.seek(0)
        if self.filename:
            return raw
        return raw.decode("utf-8", "replace")


class MultipartForm:
    def __init__(self, fields):
        self._fields = {}
        for f in fields:
            self._fields.setdefault(f.name, []).append(f)

    def __contains__(self, name):
        return name in self._fields

    def __getitem__(self, name):
        items = self._fields[name]
        return items[0] if len(items) == 1 else items

    def keys(self):
        return self._fields.keys()

    def getvalue(self, name, default=None):
        items = self._fields.get(name)
        if not items:
            return default
        if len(items) == 1:
            return items[0].value
        return [i.value for i in items]


def _boundary_from(content_type):
    m = re.search(r'boundary\s*=\s*("([^"]+)"|([^;]+))', content_type or "", re.I)
    if not m:
        raise ValueError("multipart/form-data without a boundary")
    return (m.group(2) or m.group(3)).strip().encode("latin-1")


def _parse_part_headers(head_bytes):
    name = None
    filename = None
    ctype = None
    for line in head_bytes.decode("utf-8", "replace").split("\r\n"):
        if not line:
            continue
        key, _, val = line.partition(":")
        key = key.strip().lower()
        if key == "content-disposition":
            n = re.search(r'\bname\s*=\s*"([^"]*)"', val)
            f = re.search(r'\bfilename\s*=\s*"([^"]*)"', val)
            if n:
                name = n.group(1)
            if f:
                filename = f.group(1)
        elif key == "content-type":
            ctype = val.strip()
    return name, filename, ctype


class _Scanner:
    """Reads at most `limit` bytes from `fp` and finds byte needles without loading it all."""

    def __init__(self, fp, limit):
        self.fp = fp
        self.left = max(0, int(limit or 0))
        self.buf = b""

    def _fill(self):
        if self.left <= 0:
            return False
        chunk = self.fp.read(min(_READ_CHUNK, self.left))
        if not chunk:
            self.left = 0
            return False
        self.left -= len(chunk)
        self.buf += chunk
        return True

    def drain_until(self, needle, out):
        """Consume up to and including `needle`, writing the bytes before it to `out`.

        Returns True when the needle was found, False when the body ended first (a
        truncated upload hands back what arrived instead of hanging).
        """
        while True:
            i = self.buf.find(needle)
            if i >= 0:
                head, self.buf = self.buf[:i], self.buf[i + len(needle):]
                out.write(head)
                return True
            keep = len(needle) - 1
            if len(self.buf) > keep:
                head, self.buf = self.buf[:-keep], self.buf[-keep:]
                out.write(head)
            if not self._fill():
                out.write(self.buf)
                self.buf = b""
                return False

    def read_until(self, needle):
        """Same, but returns the bytes before the needle (for small reads)."""
        out = io.BytesIO()
        self.drain_until(needle, out)
        return out.getvalue()


def parse_multipart(fp, content_type, content_length):
    boundary = _boundary_from(content_type)
    delim = b"--" + boundary
    sc = _Scanner(fp, content_length)
    # Skip the preamble up to the first delimiter.
    sc.read_until(delim)
    fields = []
    while True:
        # After a delimiter comes either "--" (the end) or CRLF and the part's headers.
        while len(sc.buf) < 2 and sc._fill():
            pass
        if sc.buf[:2] == b"--" or not sc.buf:
            break
        if sc.buf[:2] == b"\r\n":
            sc.buf = sc.buf[2:]
        head = sc.read_until(b"\r\n\r\n")
        name, filename, ctype = _parse_part_headers(head)
        body = tempfile.SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES)
        sc.drain_until(b"\r\n" + delim, body)
        body.seek(0)
        if name is not None:
            fields.append(MultipartField(name, filename, body, ctype))
        else:
            body.close()
    return MultipartForm(fields)
