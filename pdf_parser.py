import io
import re
import os
import base64
import html
import mimetypes
from pypdf import PdfReader

from epub_parser import (
    clean_tag,
    sanitize_html,
    clean_paragraph_text,
    extract_chapter_number,
    normalize_title,
    compute_chapter_fingerprint,
    detect_volume_number,
    extract_base_novel_title
)

def extract_cover_from_pdf(reader):
    """Extract embedded cover image from page 1 of PDF if available."""
    if not reader.pages:
        return None
    try:
        first_page = reader.pages[0]
        largest_img_data = None
        largest_size = 0
        img_mime = 'image/jpeg'

        for img in first_page.images:
            data = img.data
            if len(data) > largest_size:
                largest_size = len(data)
                largest_img_data = data
                ext = os.path.splitext(img.name)[1].lower()
                if ext == '.png':
                    img_mime = 'image/png'
                elif ext == '.webp':
                    img_mime = 'image/webp'
                else:
                    img_mime = 'image/jpeg'

        if largest_img_data and largest_size > 5120:
            b64 = base64.b64encode(largest_img_data).decode('utf-8')
            return f"data:{img_mime};base64,{b64}"
    except Exception:
        pass
    return None

def reconstruct_paragraphs(raw_text):
    """Reconstruct lines of text from PDF into clean, cohesive paragraphs."""
    if not raw_text:
        return []

    lines = raw_text.splitlines()
    cleaned_lines = []
    
    for line in lines:
        s = line.strip()
        if not s:
            cleaned_lines.append("")
            continue
        # Skip pure page number lines (e.g. "42" or "- 42 -")
        if re.match(r'^(?:page\s+)?-?\s*\d+\s*-?$', s, re.I):
            continue
        cleaned_lines.append(s)

    paragraphs = []
    current_buf = []
    terminal_punct = re.compile(r'[\.\!\?"\'”’…—:;]$')

    for line in cleaned_lines:
        if not line:
            if current_buf:
                paragraphs.append(" ".join(current_buf).strip())
                current_buf = []
            continue

        is_heading_pattern = re.match(r'^(?:chapter|ch|act|part|volume|prologue|epilogue|interlude)', line, re.I)
        if is_heading_pattern and len(line) < 80:
            if current_buf:
                paragraphs.append(" ".join(current_buf).strip())
                current_buf = []
            paragraphs.append(line)
            continue

        if current_buf:
            prev_line = current_buf[-1]
            if not terminal_punct.search(prev_line):
                current_buf.append(line)
            else:
                if line and line[0].islower():
                    current_buf.append(line)
                else:
                    paragraphs.append(" ".join(current_buf).strip())
                    current_buf = [line]
        else:
            current_buf.append(line)

    if current_buf:
        paragraphs.append(" ".join(current_buf).strip())

    return [p for p in paragraphs if p]

def format_paragraphs_html(paragraphs, chapter_title=""):
    """Format reconstructed paragraphs into reader-ready HTML with sequential data-pid."""
    blocks = []
    pid = 0

    if chapter_title:
        esc_title = html.escape(chapter_title)
        blocks.append(f'<h2 class="reader-heading" data-pid="{pid}" id="p-{pid}">{esc_title}</h2>')
        pid += 1

    for p in paragraphs:
        cleaned_p = clean_paragraph_text(p)
        if not cleaned_p:
            continue
        if chapter_title and cleaned_p.strip().lower() == chapter_title.strip().lower():
            continue

        esc_p = html.escape(cleaned_p)
        if re.match(r'^(?:chapter|ch|act|part|volume|prologue|epilogue|interlude) ', cleaned_p, re.I) and len(cleaned_p) < 80:
            blocks.append(f'<h2 class="reader-heading" data-pid="{pid}" id="p-{pid}">{esc_p}</h2>')
        else:
            blocks.append(f'<p class="reader-paragraph" data-pid="{pid}" id="p-{pid}">{esc_p}</p>')
        pid += 1

    formatted_html = "\n".join(blocks)
    word_count = len(re.sub(r'<[^>]+>', '', formatted_html).split())
    return formatted_html, word_count

def extract_outline_bookmarks(reader):
    """Extract table of contents from PDF bookmarks if available."""
    bookmarks = []

    def walk_outline(items):
        for it in items:
            if isinstance(it, list):
                walk_outline(it)
            else:
                try:
                    title = getattr(it, 'title', None)
                    if not title:
                        continue
                    page_num = reader.get_destination_page_number(it)
                    if page_num is not None and page_num >= 0:
                        bookmarks.append({
                            'title': str(title).strip(),
                            'page': int(page_num)
                        })
                except Exception:
                    pass

    try:
        if reader.outline:
            walk_outline(reader.outline)
    except Exception:
        pass

    bookmarks.sort(key=lambda x: x['page'])
    unique_bms = []
    seen_pages = set()
    for b in bookmarks:
        if b['page'] not in seen_pages:
            seen_pages.add(b['page'])
            unique_bms.append(b)

    return unique_bms

def parse_single_pdf(file_bytes, file_name=""):
    """Parse PDF file and return exact same format as epub_parser."""
    stream = io.BytesIO(file_bytes)
    reader = PdfReader(stream)
    total_pages = len(reader.pages)

    if total_pages == 0:
        raise ValueError(f"PDF file has no pages: {file_name}")

    doc_info = reader.metadata or {}
    pdf_title = str(doc_info.get('/Title') or '').strip()
    pdf_author = str(doc_info.get('/Author') or '').strip()
    pdf_subject = str(doc_info.get('/Subject') or '').strip()

    clean_filename_title = os.path.splitext(file_name)[0]
    title = pdf_title if (pdf_title and len(pdf_title) > 2) else clean_filename_title
    author = pdf_author if (pdf_author and len(pdf_author) > 1) else 'Unknown Author'
    description = pdf_subject or ''

    cover_data = extract_cover_from_pdf(reader)

    metadata = {
        'title': title,
        'author': author,
        'description': description,
        'cover_data': cover_data
    }

    from chaptering import repair_chapters, looks_like_chapter_title

    page_texts = []
    for p_idx in range(total_pages):
        try:
            page_texts.append(reader.pages[p_idx].extract_text() or "")
        except Exception:
            page_texts.append("")

    # Lines that repeat on many pages (book title header, author footer) are page furniture.
    from collections import Counter
    line_pages = Counter()
    for txt in page_texts:
        seen = set()
        lns = [l for l in txt.splitlines() if l.strip()]
        for ln in lns[:2] + lns[-2:]:  # headers and footers live at the page edges
            k = re.sub(r'\d+', '#', ln.strip().lower())
            if k and len(k) < 90 and k not in seen:
                seen.add(k)
                line_pages[k] += 1
    furniture = {k for k, c in line_pages.items() if total_pages >= 8 and c >= max(4, total_pages * 0.3)}

    def page_lines(txt):
        out = []
        lns = txt.splitlines()
        nonblank = [i for i, l in enumerate(lns) if l.strip()]
        edge = set(nonblank[:2] + nonblank[-2:])
        for i, ln in enumerate(lns):
            k = re.sub(r'\d+', '#', ln.strip().lower())
            if i in edge and k in furniture and not looks_like_chapter_title(ln.strip()):
                continue
            out.append(ln)
        return out

    def build(title, text, idx):
        paras = reconstruct_paragraphs(text)
        formatted_html, word_count = format_paragraphs_html(paras, title)
        if word_count > 0:
            chapters.append({'chapter_index': idx, 'title': title,
                             'content_html': formatted_html, 'word_count': word_count})

    chapters = []
    bookmarks = extract_outline_bookmarks(reader)
    # A bookmark per page (common in converted PDFs) is not a chapter list.
    if len(bookmarks) >= 2 and len(bookmarks) < max(3, total_pages * 0.9):
        for i, bm in enumerate(bookmarks):
            start_page = bm['page']
            end_page = bookmarks[i + 1]['page'] if (i + 1 < len(bookmarks)) else total_pages
            text = "\n".join("\n".join(page_lines(page_texts[p])) for p in range(start_page, min(end_page, total_pages)))
            ch_title = bm['title'] or f"Chapter {i + 1}"
            build(ch_title, text, i + 1)
        chapters = repair_chapters(chapters)

    if len(chapters) < 2:
        # Scan every line (not only page tops) for chapter headings, so chapters that
        # start mid-page are found and a heading repeated at the top of each page of
        # the same chapter (running header) does not start a new chapter.
        chapters = []
        current_title, current_norm, buf, found = None, None, [], 0
        front = []
        for txt in page_texts:
            for ln in page_lines(txt):
                s_ln = ln.strip()
                if s_ln and len(s_ln) <= 90 and looks_like_chapter_title(s_ln) and not s_ln.endswith(('.', ',')):
                    n = re.sub(r'[^a-z0-9]', '', s_ln.lower())
                    if n == current_norm:
                        continue  # running header
                    if current_title is not None:
                        build(current_title, "\n".join(buf), len(chapters) + 1)
                    elif buf:
                        front = buf
                    current_title, current_norm, buf = s_ln[:100], n, []
                    found += 1
                    continue
                buf.append(ln)
            # no blank line at the page edge: a sentence cut by the page joins back up
        if current_title is not None:
            build(current_title, "\n".join(buf), len(chapters) + 1)
        if found < 2:
            chapters = []
        elif front and len(" ".join(front).split()) > 40:
            paras = reconstruct_paragraphs("\n".join(front))
            fh, fw = format_paragraphs_html(paras, title)
            if fw:
                chapters.insert(0, {'chapter_index': 0, 'title': title, 'content_html': fh, 'word_count': fw})
                for i, c in enumerate(chapters):
                    c['chapter_index'] = i + 1

    if not chapters:
        pages_per_chapter = 15 if total_pages > 45 else (10 if total_pages > 20 else total_pages)
        ch_idx = 1
        for start_page in range(0, total_pages, pages_per_chapter):
            end_page = min(start_page + pages_per_chapter, total_pages)
            ch_text_parts = []
            for p_idx in range(start_page, end_page):
                try:
                    txt = reader.pages[p_idx].extract_text()
                    if txt:
                        ch_text_parts.append(txt)
                except Exception:
                    pass

            full_text = "\n".join(ch_text_parts)
            paras = reconstruct_paragraphs(full_text)
            
            if total_pages <= pages_per_chapter:
                ch_title = title
            else:
                ch_title = f"Part {ch_idx} (Pages {start_page + 1}-{end_page})"

            formatted_html, word_count = format_paragraphs_html(paras, ch_title)
            if word_count > 0:
                chapters.append({
                    'chapter_index': ch_idx,
                    'title': ch_title,
                    'content_html': formatted_html,
                    'word_count': word_count
                })
                ch_idx += 1

    return {
        'metadata': metadata,
        'chapters': chapters
    }
