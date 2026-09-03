import zipfile
import io
import os
import re
import uuid
import base64
import html
import mimetypes
import xml.etree.ElementTree as ET

def clean_tag(tag):
    if '}' in tag:
        return tag.split('}', 1)[1]
    return tag

def sanitize_html(raw_html):
    if not raw_html:
        return ""
    # Strip script, style, iframe, object, embed, form tags and contents
    cleaned = re.sub(r'<(script|style|iframe|object|embed|form|input)[^>]*>.*?</\1>', '', raw_html, flags=re.I | re.S)
    cleaned = re.sub(r'<(script|style|iframe|object|embed|form|input|meta|link)[^>]*?/?>', '', cleaned, flags=re.I)
    # Strip inline JavaScript event handlers
    cleaned = re.sub(r'\s+on[a-zA-Z]+\s*=\s*(["\']).*?\1', '', cleaned, flags=re.I)
    cleaned = re.sub(r'\s+on[a-zA-Z]+\s*=\s*[^ >]+', '', cleaned, flags=re.I)
    # Strip javascript: URIs
    cleaned = re.sub(r'href\s*=\s*["\']\s*javascript:[^"\']*["\']', 'href="#"', cleaned, flags=re.I)
    return cleaned

def get_opf_path(zf):
    try:
        container = zf.read('META-INF/container.xml')
        root = ET.fromstring(container)
        for elem in root.iter():
            if clean_tag(elem.tag) == 'rootfile':
                return elem.attrib.get('full-path')
    except Exception:
        pass
    for name in zf.namelist():
        if name.endswith('.opf'):
            return name
    return None

def extract_cover_data(zf, opf_root, manifest, base_dir):
    cover_href = None
    for meta in opf_root.iter():
        if clean_tag(meta.tag) == 'meta' and meta.attrib.get('name') == 'cover':
            cover_id = meta.attrib.get('content')
            if cover_id in manifest:
                cover_href = manifest[cover_id].get('href')
                break
                
    if not cover_href:
        for item in manifest.values():
            props = item.get('properties', '')
            if 'cover-image' in props:
                cover_href = item.get('href')
                break

    if not cover_href:
        for item_id, item in manifest.items():
            media = item.get('media-type', '')
            href = item.get('href', '')
            if media.startswith('image/') and ('cover' in item_id.lower() or 'cover' in href.lower()):
                cover_href = href
                break

    if cover_href:
        try:
            full_path = (base_dir + cover_href).lstrip('/')
            norm_path = os.path.normpath(full_path).replace('\\', '/')
            if norm_path not in zf.namelist():
                for name in zf.namelist():
                    if name.endswith(os.path.basename(cover_href)):
                        norm_path = name
                        break
            if norm_path in zf.namelist():
                data = zf.read(norm_path)
                mime = mimetypes.guess_type(norm_path)[0] or 'image/jpeg'
                b64 = base64.b64encode(data).decode('utf-8')
                return f"data:{mime};base64,{b64}"
        except Exception:
            pass
    return None

def parse_nav_toc(zf, base_dir, manifest):
    ncx_href = None
    for item in manifest.values():
        if item.get('media-type') == 'application/x-dtbncx+xml':
            ncx_href = item.get('href')
            break
            
    toc_map = {}
    if ncx_href:
        try:
            ncx_path = (base_dir + ncx_href).lstrip('/')
            norm_path = os.path.normpath(ncx_path).replace('\\', '/')
            if norm_path in zf.namelist():
                tree = ET.fromstring(zf.read(norm_path))
                for navpoint in tree.iter():
                    if clean_tag(navpoint.tag) == 'navPoint':
                        label_text = ''
                        content_src = ''
                        for child in navpoint:
                            ctag = clean_tag(child.tag)
                            if ctag == 'navLabel':
                                for sub in child:
                                    if clean_tag(sub.tag) == 'text' and sub.text:
                                        label_text = sub.text.strip()
                            elif ctag == 'content':
                                content_src = child.attrib.get('src', '').split('#')[0]
                        if content_src and label_text:
                            key = os.path.basename(content_src)
                            if key not in toc_map:
                                toc_map[key] = label_text
        except Exception:
            pass
    return toc_map

def clean_html_content(raw_html, zf, base_dir):
    body_match = re.search(r'<body[^>]*>(.*?)</body>', raw_html, re.I | re.S)
    content = body_match.group(1) if body_match else raw_html
    
    content = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.I | re.S)
    content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.I | re.S)

    def replace_img(match):
        attrs = match.group(1)
        src_m = re.search(r'src=["\']([^"\']+)["\']', attrs, re.I)
        if not src_m:
            return match.group(0)
        img_src = src_m.group(1)
        if img_src.startswith('data:') or img_src.startswith('http'):
            return match.group(0)
        try:
            full_img_path = os.path.normpath(os.path.join(base_dir, img_src)).replace('\\', '/').lstrip('/')
            if full_img_path not in zf.namelist():
                for name in zf.namelist():
                    if name.endswith(os.path.basename(img_src)):
                        full_img_path = name
                        break
            if full_img_path in zf.namelist():
                img_data = zf.read(full_img_path)
                mime = mimetypes.guess_type(full_img_path)[0] or 'image/jpeg'
                b64 = base64.b64encode(img_data).decode('utf-8')
                new_src = f'src="data:{mime};base64,{b64}"'
                new_attrs = re.sub(r'src=["\'][^"\']+["\']', new_src, attrs, flags=re.I)
                return f'<img {new_attrs} class="reader-image" loading="lazy" />'
        except Exception:
            pass
        return match.group(0)

    content = re.sub(r'<img\s+([^>]*?)>', replace_img, content, flags=re.I)
    content = re.sub(r'<hr[^>]*>', '<br/><br/>', content, flags=re.I)

    # Strategy: Find all leaf text blocks and split into distinct paragraphs
    raw_blocks = re.findall(r'<(p|h[1-6]|blockquote)[^>]*>(.*?)</\1>', content, re.I | re.S)

    clean_blocks = []
    pid = 0

    if raw_blocks:
        for tag, inner in raw_blocks:
            # If inner contains nested paragraph/heading tags, extract leaf children
            if re.search(r'<(p|h[1-6])[^>]*>', inner, re.I):
                nested = re.findall(r'<(p|h[1-6])[^>]*>(.*?)</\1>', inner, re.I | re.S)
                for n_tag, n_inner in nested:
                    sub_parts = re.split(r'(?:<br\s*/?>\s*){2,}|\n\s*\n', n_inner, flags=re.I)
                    for sub in sub_parts:
                        plain = re.sub(r'<[^>]+>', '', sub).strip()
                        plain = html.unescape(plain)
                        if plain or ('<img' in sub.lower()):
                            is_heading = n_tag.lower().startswith('h')
                            p_class = "reader-heading" if is_heading else "reader-paragraph"
                            clean_blocks.append(f'<{n_tag} class="{p_class}" data-pid="{pid}" id="p-{pid}">{sub.strip()}</{n_tag}>')
                            pid += 1
                continue

            # Check if this block contains multiple visual paragraphs separated by <br><br>
            sub_parts = re.split(r'(?:<br\s*/?>\s*){2,}|\n\s*\n', inner, flags=re.I)
            for sub in sub_parts:
                plain = re.sub(r'<[^>]+>', '', sub).strip()
                plain = html.unescape(plain)
                if plain or ('<img' in sub.lower()):
                    is_heading = tag.lower().startswith('h')
                    p_class = "reader-heading" if is_heading else "reader-paragraph"
                    clean_blocks.append(f'<{tag} class="{p_class}" data-pid="{pid}" id="p-{pid}">{sub.strip()}</{tag}>')
                    pid += 1
    else:
        # Fallback for EPUBs with only <div> or pure <br> text
        sub_parts = re.split(r'</?(?:div|section|article)[^>]*>|(?:<br\s*/?>\s*){1,}|\n\s*\n', content, flags=re.I)
        for sub in sub_parts:
            plain = re.sub(r'<[^>]+>', '', sub).strip()
            plain = html.unescape(plain)
            if plain or ('<img' in sub.lower()):
                clean_blocks.append(f'<p class="reader-paragraph" data-pid="{pid}" id="p-{pid}">{sub.strip()}</p>')
                pid += 1

    formatted_html = sanitize_html("\n".join(clean_blocks))
    word_count = len(re.sub(r'<[^>]+>', '', formatted_html).split())
    return formatted_html, word_count

def parse_single_epub(file_bytes, file_name=""):
    zf = zipfile.ZipFile(io.BytesIO(file_bytes))

    # Decompression bomb safeguard
    MAX_UNCOMPRESSED_SIZE = 150 * 1024 * 1024  # 150 MB
    MAX_FILES_COUNT = 3000
    total_uncompressed = 0
    file_count = 0
    for zinfo in zf.infolist():
        file_count += 1
        total_uncompressed += zinfo.file_size
        if file_count > MAX_FILES_COUNT or total_uncompressed > MAX_UNCOMPRESSED_SIZE:
            raise ValueError(f"EPUB exceeds safe extraction limits (potential decompression bomb in {file_name})")

    opf_path = get_opf_path(zf)
    if not opf_path:
        raise ValueError(f"Invalid EPUB format: missing package OPF in {file_name}")
        
    base_dir = os.path.dirname(opf_path)
    if base_dir and not base_dir.endswith('/'):
        base_dir += '/'
        
    opf_xml = zf.read(opf_path)
    opf_root = ET.fromstring(opf_xml)
    
    metadata = {
        'title': '',
        'author': 'Unknown Author',
        'description': '',
        'cover_data': None
    }
    for elem in opf_root.iter():
        tag = clean_tag(elem.tag)
        if tag == 'title' and not metadata['title']:
            metadata['title'] = elem.text.strip() if elem.text else ''
        elif tag == 'creator' and metadata['author'] == 'Unknown Author':
            metadata['author'] = elem.text.strip() if elem.text else 'Unknown Author'
        elif tag == 'description' and not metadata['description']:
            metadata['description'] = elem.text.strip() if elem.text else ''
            
    if not metadata['title']:
        metadata['title'] = os.path.splitext(file_name)[0] or 'Untitled Novel'
        
    manifest = {}
    for item in opf_root.iter():
        if clean_tag(item.tag) == 'item':
            manifest[item.attrib.get('id')] = {
                'href': item.attrib.get('href'),
                'media-type': item.attrib.get('media-type'),
                'properties': item.attrib.get('properties', '')
            }
            
    metadata['cover_data'] = extract_cover_data(zf, opf_root, manifest, base_dir)
    toc_map = parse_nav_toc(zf, base_dir, manifest)
    
    spine_hrefs = []
    for itemref in opf_root.iter():
        if clean_tag(itemref.tag) == 'itemref':
            idref = itemref.attrib.get('idref')
            if idref in manifest:
                spine_hrefs.append(manifest[idref]['href'])
                
    chapters = []
    ch_idx = 1
    for href in spine_hrefs:
        full_href = (base_dir + href).lstrip('/')
        norm_href = os.path.normpath(full_href).replace('\\', '/')
        if norm_href not in zf.namelist():
            for name in zf.namelist():
                if name.endswith(os.path.basename(href)):
                    norm_href = name
                    break
        if norm_href not in zf.namelist():
            continue
            
        raw_html = zf.read(norm_href).decode('utf-8', errors='ignore')
        
        base_name = os.path.basename(href)
        ch_title = toc_map.get(base_name)
        if not ch_title:
            h1_m = re.search(r'<h[1-2][^>]*>(.*?)</h[1-2]>', raw_html, re.I | re.S)
            if h1_m:
                ch_title = re.sub(r'<[^>]+>', '', h1_m.group(1)).strip()
            else:
                title_m = re.search(r'<title[^>]*>(.*?)</title>', raw_html, re.I | re.S)
                if title_m:
                    ch_title = re.sub(r'<[^>]+>', '', title_m.group(1)).strip()
        if not ch_title or len(ch_title) > 120:
            ch_title = f"Chapter {ch_idx}"
            
        formatted_html, word_count = clean_html_content(raw_html, zf, base_dir)
        if word_count > 0 or '<img' in formatted_html:
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

def detect_volume_number(filename, title):
    patterns = [
        r'(?:vol(?:ume)?|part|book|v)[\s._-]*(\d+)',
        r'[-_ ](\d+)(?:\.epub)?$'
    ]
    for p in patterns:
        m = re.search(p, filename, re.I)
        if m:
            return int(m.group(1))
        m2 = re.search(p, title, re.I)
        if m2:
            return int(m2.group(1))
    return 1

def extract_base_novel_title(title, filename):
    t = title
    t = re.sub(r'[-–—: ]*(?:vol(?:ume)?|part|book|v)[\s._-]*\d+.*$', '', t, flags=re.I).strip()
    if not t or len(t) < 3:
        f = os.path.splitext(filename)[0]
        t = re.sub(r'[-–—: ]*(?:vol(?:ume)?|part|book|v)[\s._-]*\d+.*$', '', f, flags=re.I).strip()
    return t or title
