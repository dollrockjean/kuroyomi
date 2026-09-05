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
        if chapter_title and p.strip().lower() == chapter_title.strip().lower():
            continue

        esc_p = html.escape(p)
        if re.match(r'^(?:chapter|ch|act|part|volume|prologue|epilogue|interlude)', p, re.I) and len(p) < 80:
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

    bookmarks = extract_outline_bookmarks(reader)
    chapters = []
    
    if len(bookmarks) >= 2:
        for i, bm in enumerate(bookmarks):
            start_page = bm['page']
            end_page = bookmarks[i + 1]['page'] if (i + 1 < len(bookmarks)) else total_pages
            
            ch_text_parts = []
            for p_idx in range(start_page, min(end_page, total_pages)):
                try:
                    txt = reader.pages[p_idx].extract_text()
                    if txt:
                        ch_text_parts.append(txt)
                except Exception:
                    pass

            full_text = "\n\n".join(ch_text_parts)
            paras = reconstruct_paragraphs(full_text)
            ch_title = bm['title'] or f"Chapter {i + 1}"
            
            ch_num_match = re.search(r'(?:chapter|ch|c)[\s._-]*(\d+)', ch_title, re.I)
            assigned_idx = int(ch_num_match.group(1)) if ch_num_match else (i + 1)

            formatted_html, word_count = format_paragraphs_html(paras, ch_title)
            if word_count > 0:
                chapters.append({
                    'chapter_index': assigned_idx,
                    'title': ch_title,
                    'content_html': formatted_html,
                    'word_count': word_count
                })

    if not chapters:
        chapter_starts = []
        heading_re = re.compile(r'^\s*(?:chapter|ch|act|part|volume)\s+([0-9ivxlcdm]+)[\s:.\-]*(.*)$', re.I)
        named_section_re = re.compile(r'^\s*(prologue|epilogue|interlude|afterword|preface)[\s:.\-]*(.*)$', re.I)

        page_texts = []
        for p_idx in range(total_pages):
            try:
                txt = reader.pages[p_idx].extract_text() or ""
            except Exception:
                txt = ""
            page_texts.append(txt)

            first_chunk = txt[:800]
            lines = [line.strip() for line in first_chunk.splitlines() if line.strip()]
            if lines:
                for line in lines[:3]:
                    m = heading_re.match(line)
                    if m:
                        chapter_starts.append({
                            'page': p_idx,
                            'title': line[:100]
                        })
                        break
                    m2 = named_section_re.match(line)
                    if m2:
                        chapter_starts.append({
                            'page': p_idx,
                            'title': line[:100]
                        })
                        break

        if len(chapter_starts) >= 2:
            for i, cs in enumerate(chapter_starts):
                start_page = cs['page']
                end_page = chapter_starts[i + 1]['page'] if (i + 1 < len(chapter_starts)) else total_pages

                ch_text_parts = page_texts[start_page:end_page]
                full_text = "\n\n".join(ch_text_parts)
                paras = reconstruct_paragraphs(full_text)
                ch_title = cs['title']

                ch_num_match = re.search(r'(?:chapter|ch|c)[\s._-]*(\d+)', ch_title, re.I)
                assigned_idx = int(ch_num_match.group(1)) if ch_num_match else (i + 1)

                formatted_html, word_count = format_paragraphs_html(paras, ch_title)
                if word_count > 0:
                    chapters.append({
                        'chapter_index': assigned_idx,
                        'title': ch_title,
                        'content_html': formatted_html,
                        'word_count': word_count
                    })

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

            full_text = "\n\n".join(ch_text_parts)
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
