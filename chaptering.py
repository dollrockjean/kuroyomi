"""Chapter break repair for imported books.

Many EPUBs and PDFs made by converters store one *page* per file (or per
bookmark), so a naive import shows every page as its own chapter. This module
decides which entries are real chapter starts and folds the rest (page
fragments) into the chapter before them. It is used at import time and by the
"Fix chapter breaks" action for books that were already imported.
"""
import html as _html
import re

# A real chapter heading: "Chapter 12", "Ch. 12: Title", "Chapter XII", "12. Title",
# "Prologue", "Epilogue", "Side Story 3", "Interlude", "Afterword"...
_CHAPTER_RE = re.compile(
    r'^\s*(?:(?:vol(?:ume)?\.?\s*\d+\s*[,:\-–—]?\s*)?'
    r'(?:chapter|ch\.?|episode|ep\.?|act|part|book)\s*[0-9ivxlcdm]+\b'
    r'|prologue|epilogue|interlude|afterword|preface|foreword|side\s*story|extra\b|bonus\b'
    r'|\d{1,4}\s*[:.\-–—]\s*\S)',
    re.I,
)
# Titles that converters give to page files. These are never chapter starts.
_PAGE_RE = re.compile(r'^\s*(?:page|pg\.?|p\.)\s*\d+\s*$|^\s*\d+\s*$|\(pages?\s*\d', re.I)
_TERMINAL = re.compile(r'[.!?"\'”’…:;)\]~*—-]\s*$')
_BLOCK_RE = re.compile(r'<(p|h[1-6]|blockquote)\b([^>]*)>(.*?)</\1>', re.I | re.S)


def looks_like_chapter_title(title):
    t = (title or "").strip()
    if not t or len(t) > 140:
        return False
    if _PAGE_RE.search(t):
        return False
    return bool(_CHAPTER_RE.match(t))


def _norm(title):
    t = re.sub(r'<[^>]+>', '', title or '')
    t = _html.unescape(t).lower()
    return re.sub(r'[^a-z0-9]', '', t)


# A page or part marker a converter tacked onto a running header: "[2]", "(part 3)", " - page 4".
_PART_SUFFIX_RE = re.compile(
    r'(?:[\[\(\{]\s*(?:pt\.?|part|page|p\.?)?\s*\d+\s*[\]\)\}]'
    r'|[\s\-–—_:,.]+(?:pt\.?|part|page)\s*\d+)\s*$',
    re.I,
)


def _norm_head(title):
    """_norm, but blind to a trailing page/part marker, so "Julien D. Evenus" and
    "Julien D. Evenus [2]" count as the same running header."""
    t = re.sub(r'<[^>]+>', '', title or '')
    t = _PART_SUFFIX_RE.sub('', _html.unescape(t).strip())
    return re.sub(r'[^a-z0-9]', '', t.lower())


def _first_heading(content_html):
    m = re.search(r'<h[1-6][^>]*>(.*?)</h[1-6]>', content_html or '', re.I | re.S)
    if m:
        return _html.unescape(re.sub(r'<[^>]+>', '', m.group(1))).strip()
    # Some converters put the chapter title in the first plain paragraph.
    m = re.search(r'<p[^>]*>(.*?)</p>', content_html or '', re.I | re.S)
    if m:
        txt = _html.unescape(re.sub(r'<[^>]+>', '', m.group(1))).strip()
        if len(txt) <= 100 and looks_like_chapter_title(txt):
            return txt
    return ''


def _chapter_label(ch):
    """Best chapter-like label for an entry, from its title or its first heading."""
    title = (ch.get('title') or '').strip()
    if looks_like_chapter_title(title):
        return title
    head = _first_heading(ch.get('content_html'))
    if looks_like_chapter_title(head):
        return head
    return ''


def plan_merge(chapters):
    """Return a list of groups (lists of indexes) or None when the book is fine.

    Only acts when the book clearly looks page-split: at least two real chapter
    starts were found and a good share of entries are fragments between them.
    """
    n = len(chapters)
    if n < 3:
        return None
    labels = [_chapter_label(c) for c in chapters]
    starts = []
    last_norm = None
    for i, lab in enumerate(labels):
        if not lab:
            continue
        nl = _norm(lab)
        if nl and nl == last_norm:
            continue  # running header repeated on the next page of the same chapter
        starts.append(i)
        last_norm = nl
    if len(starts) < 2:
        return None
    fragments = n - len(starts)
    if fragments < max(2, int(n * 0.2)):
        return None  # already chapter-per-entry, leave it alone
    groups = []
    if starts[0] > 0:
        # Front matter (cover, title page, contents) before the first chapter stays as is.
        for i in range(starts[0]):
            groups.append([i])
    for si, s in enumerate(starts):
        end = starts[si + 1] if si + 1 < len(starts) else n
        groups.append(list(range(s, end)))
    return groups


def _blocks(content_html):
    return [(m.group(1), m.group(2), m.group(3)) for m in _BLOCK_RE.finditer(content_html or '')]


def _plain(inner):
    return _html.unescape(re.sub(r'<[^>]+>', '', inner or '')).strip()


def merge_group_html(chapters, idxs, title):
    """Join the HTML of several entries into one chapter with fresh paragraph ids.

    Returns (html, word_count, pid_offsets) where pid_offsets[k] maps the old
    paragraph index 0 of entry idxs[k] to its new index, so saved positions can
    be moved to the merged chapter. Repeated running-header headings are dropped
    and a sentence cut by a page break is joined back together.
    """
    head_norm = _norm_head(title)
    out = []  # list of [tag, attrs, inner]
    pid_offsets = []
    seen_head = False
    for k, ci in enumerate(idxs):
        ch = chapters[ci]
        blocks = _blocks(ch.get('content_html'))
        if not blocks and (ch.get('content_html') or '').strip():
            blocks = [('p', '', ch['content_html'])]
        pid_offsets.append(len(out))
        first_text = True
        for tag, attrs, inner in blocks:
            plain = _plain(inner)
            is_heading = tag.lower().startswith('h')
            # Every page of a merged chapter repeats the chapter heading, often with its own page
            # marker ("... [2]"). Keep the first, drop the rest, whichever page they came from.
            if is_heading and plain and _norm_head(plain) == head_norm:
                if seen_head:
                    continue
                seen_head = True
            if k > 0 and is_heading and plain and _PAGE_RE.search(plain):
                continue  # page label on a later page
            if k > 0 and not is_heading and _PAGE_RE.search(plain):
                continue  # bare page number line
            if (k > 0 and first_text and not is_heading and out and plain
                    and out[-1][0].lower() == 'p' and '<img' not in inner.lower()):
                prev_plain = _plain(out[-1][2])
                if prev_plain and not _TERMINAL.search(prev_plain) and plain[:1].islower():
                    out[-1][2] = out[-1][2].rstrip() + ' ' + inner.lstrip()
                    first_text = False
                    continue
            if plain or '<img' in inner.lower():
                first_text = False if not is_heading else first_text
                out.append([tag, attrs, inner])
    parts = []
    for pid, (tag, attrs, inner) in enumerate(out):
        a = re.sub(r'\s*(?:data-pid|id)="[^"]*"', '', attrs or '')
        parts.append(f'<{tag}{a} data-pid="{pid}" id="p-{pid}">{inner}</{tag}>')
    merged = "\n".join(parts)
    wc = len(re.sub(r'<[^>]+>', ' ', merged).split())
    return merged, wc, pid_offsets


def repair_chapters(chapters):
    """Fix a parsed chapter list (dicts with title, content_html, word_count,
    chapter_index). Returns a new list; unchanged when the book looks fine."""
    groups = plan_merge(chapters)
    if not groups:
        return chapters
    fixed = []
    for g in groups:
        first = chapters[g[0]]
        if len(g) == 1:
            fixed.append(dict(first))
            continue
        title = _chapter_label(first) or first.get('title') or ''
        merged, wc, _ = merge_group_html(chapters, g, title)
        item = dict(first)
        item.update({'title': title, 'content_html': merged, 'word_count': wc})
        fixed.append(item)
    # Keep chapter_index strictly increasing so ordering never jumps around.
    used = []
    for i, ch in enumerate(fixed):
        idx = ch.get('chapter_index') or (i + 1)
        if used and idx <= used[-1]:
            idx = used[-1] + 1
        ch['chapter_index'] = idx
        used.append(idx)
    return fixed
