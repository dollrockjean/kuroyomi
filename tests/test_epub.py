"""Builds small real EPUB files in memory for the other tests.

test_unit, test_server, test_api_direct and test_pitch_and_quicksheet all import
`create_sample_epub` from here. The helper used to live outside the repo, so a fresh
clone (and the Windows PC) could not run those four files at all; this is it, in the repo.

The output is a valid EPUB 2 zip: mimetype first and uncompressed, META-INF/container.xml,
an OPF with metadata + manifest + spine, an NCX table of contents, and one XHTML file per
chapter. Optionally a cover image, so cover handling can be tested too.
"""

import base64
import io
import zipfile

# A 1x1 red PNG - enough for cover handling, 68 bytes.
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH"
    "/q842iQAAAABJRU5ErkJggg=="
)

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def _xml_escape(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _chapter_xhtml(title, body_html):
    return """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>%s</title></head>
<body>
<h1>%s</h1>
%s
</body>
</html>
""" % (_xml_escape(title), _xml_escape(title), body_html)


def _opf(title, author, description, chapters, with_cover):
    items = []
    spine = []
    for i, (ch_title, _html) in enumerate(chapters, start=1):
        items.append('    <item id="ch%d" href="chapter%d.xhtml" '
                     'media-type="application/xhtml+xml"/>' % (i, i))
        spine.append('    <itemref idref="ch%d"/>' % i)
    cover_meta = ""
    if with_cover:
        items.append('    <item id="cover-image" href="cover.png" media-type="image/png" '
                     'properties="cover-image"/>')
        cover_meta = '    <meta name="cover" content="cover-image"/>\n'
    return """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>%s</dc:title>
    <dc:creator opf:role="aut">%s</dc:creator>
    <dc:description>%s</dc:description>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:byob-test-%s</dc:identifier>
%s  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
%s
  </manifest>
  <spine toc="ncx">
%s
  </spine>
</package>
""" % (_xml_escape(title), _xml_escape(author), _xml_escape(description),
       abs(hash(title)) % 10 ** 8, cover_meta, "\n".join(items), "\n".join(spine))


def _ncx(title, chapters):
    points = []
    for i, (ch_title, _html) in enumerate(chapters, start=1):
        points.append(
            '    <navPoint id="np%d" playOrder="%d">\n'
            '      <navLabel><text>%s</text></navLabel>\n'
            '      <content src="chapter%d.xhtml"/>\n'
            '    </navPoint>' % (i, i, _xml_escape(ch_title), i))
    return """<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="byob-test"/></head>
  <docTitle><text>%s</text></docTitle>
  <navMap>
%s
  </navMap>
</ncx>
""" % (_xml_escape(title), "\n".join(points))


def create_sample_epub(title, author, chapters, description="A sample book for tests.",
                       with_cover=False, cover_bytes=None):
    """Return the bytes of a small valid EPUB.

    title, author: strings written into the OPF metadata.
    chapters: list of (chapter_title, body_html) in reading order.
    with_cover: add a tiny PNG cover (or `cover_bytes` if given).
    """
    if isinstance(chapters, dict):
        chapters = list(chapters.items())
    chapters = [(t, h) for t, h in chapters]
    if cover_bytes:
        with_cover = True

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # The mimetype entry must be first and stored uncompressed.
        zf.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip",
                    compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER_XML)
        zf.writestr("OEBPS/content.opf", _opf(title, author, description, chapters, with_cover))
        zf.writestr("OEBPS/toc.ncx", _ncx(title, chapters))
        for i, (ch_title, body_html) in enumerate(chapters, start=1):
            zf.writestr("OEBPS/chapter%d.xhtml" % i, _chapter_xhtml(ch_title, body_html))
        if with_cover:
            zf.writestr("OEBPS/cover.png", cover_bytes or TINY_PNG)
    return buf.getvalue()


if __name__ == "__main__":
    import os
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import epub_parser
    raw = create_sample_epub("Sample Vol 1", "Test Author",
                             [("Chapter 1: One", "<p>First line.</p><p>Second line.</p>"),
                              ("Chapter 2: Two", "<p>Another chapter.</p>")],
                             with_cover=True)
    res = epub_parser.parse_single_epub(raw, "Sample Vol 1.epub")
    print("title:", res["metadata"]["title"])
    print("author:", res["metadata"]["author"])
    print("cover:", bool(res["metadata"]["cover_data"]))
    for ch in res["chapters"]:
        print(" ", ch["chapter_index"], ch["title"], ch["word_count"], "words")
