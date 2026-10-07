"""Allowlist HTML sanitizer for book content (stdlib only).

Chapter HTML comes from files the user (or anyone with their account id) uploads, and the reader renders it with
innerHTML. A regex blacklist cannot keep that safe (`<img src=x onerror=...>` without a space, `<svg/onload=...>` and
entity-encoded `javascript:` all slip through), so this parses the markup and re-emits only known tags and attributes.
"""
import html
import re
from html.parser import HTMLParser

ALLOWED_TAGS = {
    "p", "br", "hr", "wbr", "div", "span", "em", "strong", "b", "i", "u", "s", "sub", "sup", "small", "mark", "del",
    "ins", "cite", "q", "abbr", "center", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol",
    "li", "a", "img", "ruby", "rt", "rp", "figure", "figcaption", "table", "thead", "tbody", "tr", "td", "th",
}
VOID_TAGS = {"br", "hr", "wbr", "img"}
# Elements whose content must disappear with the tag, not be unwrapped into the page
DROP_WITH_CONTENT = {
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "noscript", "noembed", "noframes", "template",
    "svg", "math", "form", "textarea", "select", "button", "title", "head", "applet", "audio", "video", "canvas",
    "xmp", "plaintext", "listing",
}

_CLASS_OK = re.compile(r"^[A-Za-z0-9_\- ]{1,200}$")
_ID_OK = re.compile(r"^[A-Za-z0-9_\-:.]{1,100}$")
_DIGITS = re.compile(r"^[0-9]{1,9}$")
_ENTITY_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,31}$")
_CHARREF = re.compile(r"^(?:[0-9]{1,7}|[xX][0-9A-Fa-f]{1,6})$")
_DATA_IMG = re.compile(r"^data:image/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$", re.I)
_URL_JUNK = re.compile(r"[\x00-\x20\x7f-\x9f​-‏  ﻿]+")


def _safe_url(value, allow_data_image=False):
    """Return the URL if its scheme is on the allowlist, else None. Normalises the tricks browsers tolerate."""
    if value is None:
        return None
    probe = _URL_JUNK.sub("", value).lower()
    if allow_data_image and probe.startswith("data:"):
        return value.strip() if _DATA_IMG.match(value.strip()) else None
    if probe.startswith(("http://", "https://", "mailto:", "#")):
        return value.strip()
    return None


def _clean_attrs(tag, attrs):
    out = []
    for name, value in attrs:
        name = (name or "").lower()
        if value is None:
            value = ""
        if name == "class" and _CLASS_OK.match(value):
            out.append(("class", value))
        elif name == "id" and _ID_OK.match(value):
            out.append(("id", value))
        elif name == "data-pid" and _DIGITS.match(value):
            out.append(("data-pid", value))
        elif name in ("title", "alt") and len(value) <= 500:
            out.append((name, value))
        elif name in ("lang", "dir") and re.match(r"^[A-Za-z\-]{1,12}$", value):
            out.append((name, value))
        elif tag == "img" and name == "src":
            url = _safe_url(value, allow_data_image=True)
            if url:
                out.append(("src", url))
        elif tag == "img" and name in ("width", "height") and _DIGITS.match(value):
            out.append((name, value))
        elif tag == "img" and name == "loading" and value in ("lazy", "eager"):
            out.append(("loading", value))
        elif tag == "a" and name == "href":
            url = _safe_url(value)
            if url:
                out.append(("href", url))
        elif tag in ("td", "th") and name in ("colspan", "rowspan") and _DIGITS.match(value):
            out.append((name, value))
    if tag == "a":
        out.append(("rel", "noopener noreferrer"))
    if tag == "img" and not any(n == "src" for n, _ in out):
        return None  # an image with no safe source is just noise
    return out


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.out = []
        self.stack = []
        self.skip = 0

    # -- tags
    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.skip:
            if tag in DROP_WITH_CONTENT:
                self.skip += 1
            return
        if tag in DROP_WITH_CONTENT:
            if tag not in VOID_TAGS:
                self.skip = 1
            return
        if tag not in ALLOWED_TAGS:
            return  # unwrap: keep the text, lose the element
        cleaned = _clean_attrs(tag, attrs)
        if cleaned is None:
            return
        attr_text = "".join(f' {n}="{html.escape(v, quote=True)}"' for n, v in cleaned)
        self.out.append(f"<{tag}{attr_text}>")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        self.handle_starttag(tag, attrs)
        if tag in ALLOWED_TAGS and tag not in VOID_TAGS and not self.skip:
            self.handle_endtag(tag)
        elif tag in DROP_WITH_CONTENT and self.skip:
            self.skip = max(0, self.skip - 1)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.skip:
            if tag in DROP_WITH_CONTENT:
                self.skip -= 1
            return
        if tag in VOID_TAGS or tag not in ALLOWED_TAGS or tag not in self.stack:
            return
        while self.stack:
            top = self.stack.pop()
            self.out.append(f"</{top}>")
            if top == tag:
                break

    # -- text
    def handle_data(self, data):
        if not self.skip:
            self.out.append(html.escape(data, quote=False))

    def handle_entityref(self, name):
        if self.skip:
            return
        self.out.append(f"&{name};" if _ENTITY_NAME.match(name) else html.escape(f"&{name};", quote=False))

    def handle_charref(self, name):
        if self.skip:
            return
        self.out.append(f"&#{name};" if _CHARREF.match(name) else html.escape(f"&#{name};", quote=False))

    # -- everything else is dropped
    def handle_comment(self, data):
        pass

    def handle_decl(self, decl):
        pass

    def handle_pi(self, data):
        pass

    def unknown_decl(self, data):
        pass


def sanitize_html(raw_html):
    """Return `raw_html` reduced to the allowlisted tags and attributes. Safe to apply repeatedly."""
    if not raw_html:
        return ""
    parser = _Sanitizer()
    parser.feed(raw_html)
    parser.close()
    while parser.stack:  # close anything left open so it cannot swallow the surrounding page
        parser.out.append(f"</{parser.stack.pop()}>")
    return "".join(parser.out)
