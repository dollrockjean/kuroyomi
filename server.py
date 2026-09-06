import http.server
import socketserver
import os
import io
import json
import re
import cgi
import time
import uuid
import urllib.parse
import mimetypes
import hashlib
import tempfile
import asyncio
import sys

# Ensure user site-packages is searched for neural TTS modules
for p in [os.path.expanduser("~/Library/Python/3.9/lib/python/site-packages"),
          os.path.expanduser("~/.local/lib/python3.9/site-packages")]:
    if os.path.exists(p) and p not in sys.path:
        sys.path.insert(0, p)

import database
import epub_parser
import pdf_parser
import sample_books

PORT = int(os.environ.get("PORT", 8000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

TTS_CACHE_DIR = os.path.join(tempfile.gettempdir(), "kuroyomi_tts_cache")
os.makedirs(TTS_CACHE_DIR, exist_ok=True)

BUILTIN_NEURAL_VOICES = [
    {"id": "en-US-BrianNeural", "name": "Brian", "description": "Rich Baritone (Default)", "gender": "Male"},
    {"id": "en-US-AvaNeural", "name": "Ava", "description": "Expressive & Natural", "gender": "Female"},
    {"id": "en-US-AndrewNeural", "name": "Andrew", "description": "Dynamic American", "gender": "Male"},
    {"id": "en-US-EmmaNeural", "name": "Emma", "description": "Warm & Articulate", "gender": "Female"},
    {"id": "en-US-ChristopherNeural", "name": "Christopher", "description": "Deep Resonant", "gender": "Male"},
    {"id": "en-GB-RyanNeural", "name": "Ryan", "description": "Classic British", "gender": "Male"},
    {"id": "en-GB-SoniaNeural", "name": "Sonia", "description": "Refined British", "gender": "Female"},
    {"id": "en-AU-WilliamMultilingualNeural", "name": "William", "description": "Smooth Australian", "gender": "Male"}
]

def normalize_text_for_narration(text: str) -> str:
    """Preprocesses web novel prose to ensure natural human cadence and eliminate robotic monotone."""
    if not text:
        return ""
    # Strip any leaked HTML tags
    clean = re.sub(r"<[^>]+>", "", text)
    # Convert status/system brackets like [Level Up] or 【Warning】 into natural spoken clauses
    clean = re.sub(r"[\[【《](.*?)[\]】》]", r" \1 ", clean)
    # Normalize long ellipses (.... or ……) into a natural breath pause
    clean = re.sub(r"\.{3,}|…+", ", ... ", clean)
    # Convert em-dashes into spaced em-dashes for natural dialogue beats
    clean = re.sub(r"[\u2013\u2014]+|--+", " — ", clean)
    # Collapse multiple whitespace
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean

def normalize_rate(rate_str):
    if not rate_str:
        return "+0%"
    rate_str = str(rate_str).strip()
    try:
        val = float(rate_str.replace('%', '').replace('+', ''))
        if 0.1 <= val <= 3.0 and '%' not in rate_str:
            pct = int(round((val - 1.0) * 100))
            return f"+{pct}%" if pct >= 0 else f"{pct}%"
    except ValueError:
        pass

    m = re.match(r'^[+\-]?\s*(\d+)\s*%?$', rate_str)
    if m:
        val = int(m.group(1))
        if rate_str.strip().startswith('-'):
            return f"-{val}%"
        else:
            return f"+{val}%"
    return "+0%"

VALID_VOICES = {
    "en-US-BrianNeural",
    "en-US-AvaNeural",
    "en-US-AndrewNeural",
    "en-US-EmmaNeural",
    "en-US-ChristopherNeural",
    "en-GB-RyanNeural",
    "en-GB-SoniaNeural",
    "en-AU-WilliamMultilingualNeural"
}

def synthesize_speech(text, voice="en-US-BrianNeural", rate="+0%"):
    clean_text = normalize_text_for_narration(text)
    if not clean_text:
        return None

    if voice not in VALID_VOICES:
        print(f"[TTS] Voice '{voice}' not in whitelist, falling back to en-US-BrianNeural")
        voice = "en-US-BrianNeural"

    norm_rate = normalize_rate(rate)

    cache_key = hashlib.sha256(f"{voice}_{norm_rate}_{clean_text}".encode('utf-8')).hexdigest()
    cache_file = os.path.join(TTS_CACHE_DIR, f"{cache_key}.mp3")
    if os.path.exists(cache_file) and os.path.getsize(cache_file) > 0:
        with open(cache_file, "rb") as f:
            return f.read()

    try:
        import edge_tts
        async def _run():
            comm = edge_tts.Communicate(clean_text, voice, rate=norm_rate)
            buf = io.BytesIO()
            async for chunk in comm.stream():
                if chunk['type'] == 'audio':
                    buf.write(chunk['data'])
            return buf.getvalue()

        data = asyncio.run(_run())
        if data and len(data) > 100:
            with open(cache_file, "wb") as f:
                f.write(data)
            return data
    except Exception as e:
        import traceback
        print(f"[TTS] Neural TTS synthesis error for voice='{voice}' rate='{norm_rate}': {e}")
        traceback.print_exc()

        # Resilient fallback retry with default Brian voice if custom voice/rate had an edge error
        if voice != "en-US-BrianNeural" or norm_rate != "+0%":
            try:
                print("[TTS] Retrying synthesis with default Brian voice...")
                async def _fallback_run():
                    comm = edge_tts.Communicate(clean_text, "en-US-BrianNeural", rate="+0%")
                    buf = io.BytesIO()
                    async for chunk in comm.stream():
                        if chunk['type'] == 'audio':
                            buf.write(chunk['data'])
                    return buf.getvalue()
                data = asyncio.run(_fallback_run())
                if data and len(data) > 100:
                    with open(cache_file, "wb") as f:
                        f.write(data)
                    return data
            except Exception as fb_err:
                print(f"[TTS] Fallback retry failed: {fb_err}")

    return None

class NovelReaderHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Token")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ("/sw.js", "/service-worker.js"):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        elif path in ("", "/", "/index.html"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        elif any(path.startswith(p) for p in ("/js/", "/css/", "/icons/")):
            self.send_header("Cache-Control", "public, max-age=86400")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Token")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/") or path in ("/health", "/ping"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        if path in ("", "/"):
            self.path = "/index.html"
        return super().do_HEAD()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # API routing & health checks
        if path.startswith("/api/") or path in ("/health", "/ping"):
            try:
                self.handle_api_get(path, query)
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
            return

        # Default to index.html for SPA routes or root
        if path in ("", "/"):
            self.path = "/index.html"
            return super().do_GET()

        # Path traversal protection: ensure resolved path is inside PUBLIC_DIR
        disk_path = os.path.normpath(os.path.join(PUBLIC_DIR, path.lstrip("/")))
        if not disk_path.startswith(PUBLIC_DIR):
            self.send_json({"error": "Forbidden"}, status=403)
            return

        # Check if file exists in public/
        if os.path.exists(disk_path) and os.path.isfile(disk_path):
            return super().do_GET()

        # Fallback to index.html
        self.path = "/index.html"
        return super().do_GET()

    def handle_api_get(self, path, query):
        conn = database.get_db()
        cur = conn.cursor()

        # 1. Device Session Check ("Remember This Device")
        if path == "/api/auth/device-session":
            device_token = query.get("device_token", [""])[0]
            if not device_token:
                self.send_json({"authenticated": False}, status=200)
                conn.close()
                return

            user_data = database.get_user_by_device(device_token)
            if not user_data:
                self.send_json({"authenticated": False}, status=200)
                conn.close()
                return

            cur.execute("SELECT * FROM user_settings WHERE user_id = ?", (user_data["id"],))
            settings_row = cur.fetchone()
            settings = dict(settings_row) if settings_row else {}

            self.send_json({
                "authenticated": True,
                "user_id": user_data["id"],
                "sync_key": user_data["sync_key"],
                "display_name": user_data["display_name"],
                "device_name": user_data.get("device_name", ""),
                "is_remembered": bool(user_data.get("is_remembered", 1)),
                "settings": settings
            })
            conn.close()
            return

        # 2. Get User Devices
        if path == "/api/devices":
            user_id = query.get("user_id", [""])[0]
            if not user_id:
                self.send_json({"error": "user_id required"}, status=400)
                conn.close()
                return
            devices = database.get_user_devices(user_id)
            self.send_json({"devices": devices})
            conn.close()
            return

        # 3. Get Novels List
        if path == "/api/novels":
            user_id = query.get("user_id", [""])[0]
            if not user_id or user_id in ("universal_device_mirror", "READER-PRIMARY", "default_user"):
                cur.execute("""
                    SELECT u.id FROM users u
                    JOIN novels n ON u.id = n.user_id
                    GROUP BY u.id
                    ORDER BY COUNT(n.id) DESC, u.last_active DESC
                    LIMIT 1
                """)
                primary_user = cur.fetchone()
                if primary_user and primary_user["id"]:
                    user_id = primary_user["id"]
                elif not user_id:
                    self.send_json({"novels": []})
                    conn.close()
                    return

            # Check if user needs demo novel seeded initially
            database.ensure_user_exists(user_id)
            cur.execute("SELECT demo_seeded, sync_key FROM users WHERE id = ?", (user_id,))
            user_row = cur.fetchone()
            if user_row and not user_row["demo_seeded"]:
                cur.execute("SELECT COUNT(*) as cnt FROM novels WHERE user_id = ?", (user_id,))
                if cur.fetchone()["cnt"] == 0:
                    if user_row["sync_key"] in ("DEFAULT_READER", "READER-PRIMARY") or user_id.startswith("test_user"):
                        sample_books.seed_demo_novel(user_id)
                        conn.commit()
                    else:
                        cur.execute("UPDATE users SET demo_seeded = 1 WHERE id = ?", (user_id,))
                        conn.commit()
                else:
                    cur.execute("UPDATE users SET demo_seeded = 1 WHERE id = ?", (user_id,))
                    conn.commit()

            cur.execute("""
                SELECT n.*,
                       COUNT(DISTINCT v.id) as volume_count,
                       COUNT(DISTINCT c.id) as total_chapters,
                       p.chapter_id as progress_chapter_id,
                       p.paragraph_index as progress_paragraph,
                       p.scroll_percent as progress_scroll,
                       p.updated_at as last_read_at,
                       last_ch.title as last_chapter_title,
                       last_ch.global_index as last_chapter_global_index
                FROM novels n
                LEFT JOIN volumes v ON n.id = v.novel_id
                LEFT JOIN chapters c ON n.id = c.novel_id
                LEFT JOIN reading_progress p ON n.id = p.novel_id AND p.user_id = n.user_id
                LEFT JOIN chapters last_ch ON p.chapter_id = last_ch.id
                WHERE n.user_id = ?
                GROUP BY n.id
                ORDER BY COALESCE(p.updated_at, n.created_at) DESC
            """, (user_id,))
            rows = [dict(r) for r in cur.fetchall()]
            for r in rows:
                tot = r.get("total_chapters") or 0
                g_idx = r.get("last_chapter_global_index")
                s_pct = r.get("progress_scroll") or 0.0
                if tot > 0 and g_idx is not None and g_idx > 0:
                    overall = ((g_idx - 1) + (s_pct / 100.0)) / float(tot) * 100.0
                    r["progress_overall_percent"] = round(min(100.0, max(0.0, overall)), 1)
                else:
                    r["progress_overall_percent"] = 0.0
            conn.close()
            self.send_json({"novels": rows})
            return

        # 4. Get Novel Details + Volume Breakdown
        nov_match = re.match(r"^/api/novels/([^/]+)$", path)
        if nov_match:
            novel_id = nov_match.group(1)
            user_id = query.get("user_id", [""])[0]
            cur.execute("SELECT * FROM novels WHERE id = ?", (novel_id,))
            nov_row = cur.fetchone()
            if not nov_row:
                self.send_json({"error": "Novel not found"}, status=404)
                conn.close()
                return

            cur.execute("SELECT * FROM volumes WHERE novel_id = ? ORDER BY volume_number ASC", (novel_id,))
            volumes = [dict(v) for v in cur.fetchall()]

            cur.execute("""
                SELECT id, volume_id, chapter_index, global_index, title, word_count
                FROM chapters WHERE novel_id = ?
                ORDER BY global_index ASC
            """, (novel_id,))
            chapters = [dict(c) for c in cur.fetchall()]

            # Progress
            progress = None
            if user_id:
                cur.execute("SELECT * FROM reading_progress WHERE novel_id = ? AND user_id = ?", (novel_id, user_id))
                prog_row = cur.fetchone()
                if prog_row:
                    progress = dict(prog_row)
            if not progress:
                cur.execute("SELECT * FROM reading_progress WHERE novel_id = ? ORDER BY updated_at DESC LIMIT 1", (novel_id,))
                prog_row = cur.fetchone()
                if prog_row:
                    progress = dict(prog_row)

            conn.close()
            self.send_json({
                "novel": dict(nov_row),
                "volumes": volumes,
                "chapters": chapters,
                "progress": progress
            })
            return

        # 5. Get Chapter Content
        ch_match = re.match(r"^/api/chapters/([^/]+)$", path)
        if ch_match:
            chapter_id = ch_match.group(1)
            cur.execute("""
                SELECT c.*, v.title as volume_title, v.volume_number, n.title as novel_title
                FROM chapters c
                JOIN volumes v ON c.volume_id = v.id
                JOIN novels n ON c.novel_id = n.id
                WHERE c.id = ?
            """, (chapter_id,))
            ch_row = cur.fetchone()
            if not ch_row:
                self.send_json({"error": "Chapter not found"}, status=404)
                conn.close()
                return

            ch_dict = dict(ch_row)
            # Find previous and next chapter
            novel_id = ch_dict["novel_id"]
            global_idx = ch_dict["global_index"]

            cur.execute("""
                SELECT id, title, global_index FROM chapters
                WHERE novel_id = ? AND global_index < ?
                ORDER BY global_index DESC LIMIT 1
            """, (novel_id, global_idx))
            prev_row = cur.fetchone()
            ch_dict["prev_chapter"] = dict(prev_row) if prev_row else None

            cur.execute("""
                SELECT id, title, global_index FROM chapters
                WHERE novel_id = ? AND global_index > ?
                ORDER BY global_index ASC LIMIT 1
            """, (novel_id, global_idx))
            next_row = cur.fetchone()
            ch_dict["next_chapter"] = dict(next_row) if next_row else None

            conn.close()
            self.send_json(ch_dict)
            return

        # 6. Last Read Novel / Quick Resume Hero
        if path == "/api/last-read":
            user_id = query.get("user_id", [""])[0]
            if not user_id or user_id in ("universal_device_mirror", "READER-PRIMARY", "default_user"):
                cur.execute("""
                    SELECT p.user_id FROM reading_progress p
                    ORDER BY p.updated_at DESC LIMIT 1
                """)
                p_row = cur.fetchone()
                if p_row and p_row["user_id"]:
                    user_id = p_row["user_id"]
                elif not user_id:
                    self.send_json({"last_read": None})
                    conn.close()
                    return

            cur.execute("""
                SELECT p.*, n.title as novel_title, n.cover_data, n.author as novel_author,
                       c.title as chapter_title, c.global_index as chapter_global_index,
                       v.title as volume_title, v.volume_number
                FROM reading_progress p
                JOIN novels n ON p.novel_id = n.id
                JOIN chapters c ON p.chapter_id = c.id
                JOIN volumes v ON p.volume_id = v.id
                WHERE p.user_id = ?
                ORDER BY p.updated_at DESC LIMIT 1
            """, (user_id,))
            last_row = cur.fetchone()
            last_data = dict(last_row) if last_row else None
            if last_data:
                cur.execute("SELECT COUNT(*) as total_chapters FROM chapters WHERE novel_id = ?", (last_data["novel_id"],))
                tot_row = cur.fetchone()
                tot = tot_row["total_chapters"] if tot_row else 1
                g_idx = last_data.get("chapter_global_index") or 1
                s_pct = last_data.get("scroll_percent") or 0.0
                if tot > 0:
                    overall = ((g_idx - 1) + (s_pct / 100.0)) / float(tot) * 100.0
                    last_data["progress_overall_percent"] = round(min(100.0, max(0.0, overall)), 1)
                else:
                    last_data["progress_overall_percent"] = 0.0
            conn.close()
            self.send_json({"last_read": last_data})
            return

        # 7. Get Settings
        if path == "/api/settings":
            user_id = query.get("user_id", [""])[0]
            if not user_id or user_id in ("universal_device_mirror", "READER-PRIMARY", "default_user"):
                cur.execute("""
                    SELECT u.id FROM users u
                    JOIN user_settings s ON u.id = s.user_id
                    GROUP BY u.id
                    ORDER BY u.last_active DESC
                    LIMIT 1
                """)
                p_row = cur.fetchone()
                if p_row and p_row["id"]:
                    user_id = p_row["id"]
            if not user_id:
                self.send_json({"settings": {}})
                conn.close()
                return
            cur.execute("SELECT * FROM user_settings WHERE user_id = ?", (user_id,))
            row = cur.fetchone()
            conn.close()
            self.send_json({"settings": dict(row) if row else {}})
            return

        # 8. Realistic Neural TTS Audio Stream with HTTP Range Support (Required for Safari & iOS)
        if path == "/api/tts/speak":
            text = query.get("text", [""])[0]
            voice = query.get("voice", ["en-US-BrianNeural"])[0]
            rate = query.get("rate", ["+0%"])[0]

            if not text:
                conn.close()
                self.send_json({"error": "text query param required"}, status=400)
                return

            audio_data = synthesize_speech(text, voice, rate)
            conn.close()
            if not audio_data:
                self.send_json({"error": "Neural TTS unavailable"}, status=503)
                return

            total_len = len(audio_data)
            range_header = self.headers.get("Range")

            if range_header and range_header.startswith("bytes="):
                parts = range_header[6:].split("-")
                start = int(parts[0]) if parts[0] else 0
                end = int(parts[1]) if len(parts) > 1 and parts[1] else total_len - 1
                if start >= total_len:
                    start = total_len - 1
                if end >= total_len:
                    end = total_len - 1

                chunk = audio_data[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Range", f"bytes {start}-{end}/{total_len}")
                self.send_header("Content-Length", str(len(chunk)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(chunk)
            else:
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(total_len))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(audio_data)
            return

        # 9. Realistic Neural Voices List
        if path == "/api/tts/voices":
            conn.close()
            self.send_json({"voices": BUILTIN_NEURAL_VOICES})
            return

        # 10. Health Check (for Cloud Deployments: Render, Railway, Fly.io)
        if path in ("/health", "/api/health"):
            conn.close()
            self.send_json({"status": "healthy", "service": "kuroyomi", "timestamp": time.time()})
            return

        # 11. Database Backup Export (Safeguard for Free Ephemeral Hosting)
        if path == "/api/backup":
            user_id = query.get("user_id", [""])[0]
            if not user_id or user_id in ("universal_device_mirror", "READER-PRIMARY", "default_user"):
                cur.execute("""
                    SELECT u.id FROM users u
                    JOIN novels n ON u.id = n.user_id
                    GROUP BY u.id
                    ORDER BY COUNT(n.id) DESC, u.last_active DESC
                    LIMIT 1
                """)
                primary_user = cur.fetchone()
                if primary_user and primary_user["id"]:
                    user_id = primary_user["id"]
            conn.close()
            if not user_id:
                self.send_json({"error": "user_id required"}, status=400)
                return
            backup_data = database.export_backup_data(user_id)
            self.send_json(backup_data)
            return

        conn.close()
        self.send_json({"error": "Endpoint not found"}, status=404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/upload":
            try:
                self.handle_upload()
            except Exception as e:
                self.send_json({"error": f"Upload failed: {str(e)}"}, status=500)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50MB limit safeguard
        if content_length > MAX_UPLOAD_SIZE:
            self.send_json({"error": "Payload exceeds 50MB upload limit"}, status=413)
            return

        post_data = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            body = json.loads(post_data) if post_data else {}
        except Exception:
            body = {}

        try:
            self.handle_api_post(path, body)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def handle_api_post(self, path, body):
        import secrets
        conn = database.get_db()
        cur = conn.cursor()

        # 1. Register Device / Sync Profile (High-Entropy Cryptographic Keys)
        if path == "/api/auth/register-device":
            sync_key = body.get("sync_key", "").strip().upper()
            device_token = body.get("device_token", "").strip() or f"dev_{secrets.token_hex(16)}"
            device_name = body.get("device_name", "Web Browser").strip()
            requested_user_id = body.get("user_id", "").strip()
            user_agent = self.headers.get("User-Agent", "")
            remember = bool(body.get("remember", True))

            if not sync_key or sync_key in ("DEFAULT_READER", "OFFLINE", "READER-PRIMARY"):
                if requested_user_id and requested_user_id.startswith("usr_"):
                    cur.execute("SELECT sync_key FROM users WHERE id = ?", (requested_user_id,))
                    u_row = cur.fetchone()
                    if u_row and u_row["sync_key"]:
                        sync_key = u_row["sync_key"]

                if not sync_key or sync_key in ("DEFAULT_READER", "OFFLINE", "READER-PRIMARY"):
                    cur.execute("""
                        SELECT u.sync_key, u.id FROM users u 
                        JOIN novels n ON u.id = n.user_id 
                        WHERE u.sync_key NOT IN ('OFFLINE', 'DEFAULT_READER')
                        GROUP BY u.id 
                        ORDER BY COUNT(n.id) DESC, u.last_active DESC 
                        LIMIT 1
                    """)
                    primary_user = cur.fetchone()
                    if primary_user and primary_user["sync_key"]:
                        sync_key = primary_user["sync_key"]
                        requested_user_id = primary_user["id"]
                    else:
                        sync_key = "READER-PRIMARY"

            user_id = database.get_or_create_user(sync_key, requested_user_id=requested_user_id)
            database.register_device(user_id, device_token, device_name, user_agent, remember)

            # Get user settings
            cur.execute("SELECT * FROM user_settings WHERE user_id = ?", (user_id,))
            s_row = cur.fetchone()
            settings = dict(s_row) if s_row else {}

            conn.close()
            self.send_json({
                "success": True,
                "user_id": user_id,
                "sync_key": sync_key,
                "device_token": device_token,
                "device_name": device_name,
                "is_remembered": remember,
                "settings": settings
            })
            return

        # 2. Unlink Device
        if path == "/api/devices/unlink":
            user_id = body.get("user_id")
            device_token = body.get("device_token")
            if user_id and device_token:
                database.unlink_device(user_id, device_token)
            conn.close()
            self.send_json({"success": True})
            return

        # 3. Save Reading Progress (Exact paragraph and scroll percent)
        if path == "/api/progress":
            user_id = body.get("user_id")
            novel_id = body.get("novel_id")
            volume_id = body.get("volume_id")
            chapter_id = body.get("chapter_id")
            paragraph_index = int(body.get("paragraph_index", 0))
            scroll_percent = float(body.get("scroll_percent", 0.0))

            if not all([user_id, novel_id, volume_id, chapter_id]):
                self.send_json({"error": "Missing required progress fields"}, status=400)
                conn.close()
                return

            database.ensure_user_exists(user_id)
            now = time.time()
            prog_id = f"prog_{uuid.uuid4().hex[:12]}"
            cur.execute("""
                INSERT INTO reading_progress (id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, novel_id) DO UPDATE SET
                    volume_id = excluded.volume_id,
                    chapter_id = excluded.chapter_id,
                    paragraph_index = excluded.paragraph_index,
                    scroll_percent = excluded.scroll_percent,
                    updated_at = excluded.updated_at
            """, (prog_id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, now))
            conn.commit()
            conn.close()
            self.send_json({"success": True, "updated_at": now})
            return

        # 4. Save Settings
        if path == "/api/settings":
            user_id = body.get("user_id")
            if not user_id:
                self.send_json({"error": "user_id required"}, status=400)
                conn.close()
                return

            database.ensure_user_exists(user_id)

            theme = body.get("theme", "monochrome-dark")
            font_family = body.get("font_family", "times")
            font_size = int(body.get("font_size", 19))
            line_height = float(body.get("line_height", 1.85))
            content_width = body.get("content_width", "normal")
            auto_scroll_speed = int(body.get("auto_scroll_speed", 35))
            tts_voice = body.get("tts_voice", "en-US-JennyNeural")
            tts_rate = float(body.get("tts_rate", 1.0))
            tts_pitch = float(body.get("tts_pitch", 1.0))
            library_view_mode = body.get("library_view_mode", "tile")
            library_sort_by = body.get("library_sort_by", "last_read")
            now = time.time()

            cur.execute("""
                INSERT INTO user_settings (user_id, theme, font_family, font_size, line_height, content_width, auto_scroll_speed, tts_voice, tts_rate, tts_pitch, library_view_mode, library_sort_by, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    theme = excluded.theme,
                    font_family = excluded.font_family,
                    font_size = excluded.font_size,
                    line_height = excluded.line_height,
                    content_width = excluded.content_width,
                    auto_scroll_speed = excluded.auto_scroll_speed,
                    tts_voice = excluded.tts_voice,
                    tts_rate = excluded.tts_rate,
                    tts_pitch = excluded.tts_pitch,
                    library_view_mode = excluded.library_view_mode,
                    library_sort_by = excluded.library_sort_by,
                    updated_at = excluded.updated_at
            """, (user_id, theme, font_family, font_size, line_height, content_width, auto_scroll_speed, tts_voice, tts_rate, tts_pitch, library_view_mode, library_sort_by, now))
            conn.commit()
            conn.close()
            self.send_json({"success": True, "updated_at": now})
            return

        # 5. Delete Novel
        if path.startswith("/api/novels/delete"):
            novel_id = body.get("novel_id")
            user_id = body.get("user_id")
            if novel_id:
                cur.execute("DELETE FROM novels WHERE id = ?", (novel_id,))
                if user_id:
                    cur.execute("UPDATE users SET demo_seeded = 1 WHERE id = ?", (user_id,))
                conn.commit()
            conn.close()
            self.send_json({"success": True})
            return

        # 6. Restore Database from Backup (Safeguard for Free Cloud Hosting)
        if path == "/api/restore":
            user_id = body.get("user_id")
            backup_data = body.get("backup_data")
            conn.close()
            if not user_id or not backup_data:
                self.send_json({"error": "user_id and backup_data required"}, status=400)
                return
            try:
                res = database.import_backup_data(backup_data, user_id)
                self.send_json({"success": True, **res})
            except Exception as e:
                self.send_json({"error": f"Restore failed: {str(e)}"}, status=500)
            return

        # 7. Update Novel Cover Image
        if path == "/api/novels/cover":
            novel_id = body.get("novel_id")
            user_id = body.get("user_id")
            cover_data = body.get("cover_data")
            conn.close()
            if not novel_id or not user_id or not cover_data:
                self.send_json({"error": "novel_id, user_id, and cover_data are required"}, status=400)
                return
            database.update_novel_cover(novel_id, user_id, cover_data)
            self.send_json({"success": True})
            return

        conn.close()
        self.send_json({"error": "Endpoint not found"}, status=404)

    def handle_upload(self):
        # Parse multipart/form-data
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_json({"error": "Expected multipart/form-data"}, status=400)
            return

        # Use cgi.FieldStorage to extract uploaded files and fields
        environ = {
            'REQUEST_METHOD': 'POST',
            'CONTENT_TYPE': content_type,
            'CONTENT_LENGTH': self.headers.get('Content-Length', '0')
        }
        fs = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=environ)

        user_id = fs.getvalue("user_id")
        if not user_id:
            self.send_json({"error": "user_id is required"}, status=400)
            return

        database.ensure_user_exists(user_id)

        novel_id = fs.getvalue("novel_id") or fs.getvalue("target_novel_id")  # Optional: add to existing novel series
        custom_series_title = fs.getvalue("series_title")

        # Collect files
        file_items = []
        if "files" in fs:
            items = fs["files"]
            if not isinstance(items, list):
                items = [items]
            for it in items:
                if it.filename:
                    file_items.append(it)
        elif "file" in fs:
            items = fs["file"]
            if not isinstance(items, list):
                items = [items]
            for it in items:
                if it.filename:
                    file_items.append(it)

        if not file_items:
            self.send_json({"error": "No EPUB or PDF files provided"}, status=400)
            return

        # Determine client requested file order if provided
        file_order_raw = fs.getvalue("file_order")
        order_map = {}
        if file_order_raw:
            try:
                order_list = json.loads(file_order_raw) if isinstance(file_order_raw, str) else file_order_raw
                if isinstance(order_list, list):
                    order_map = {name: idx for idx, name in enumerate(order_list)}
            except Exception:
                order_map = {}

        def natural_sort_key(s):
            return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s or '')]

        def file_item_sort_key(it):
            fname = it.filename or ''
            if fname in order_map:
                return (0, order_map[fname])
            return (1, natural_sort_key(fname))

        file_items.sort(key=file_item_sort_key)

        # Parse each file
        parsed_files = []
        for it in file_items:
            fname = it.filename
            data = it.file.read()
            try:
                if fname.lower().endswith('.pdf'):
                    parsed_res = pdf_parser.parse_single_pdf(data, fname)
                    vol_num = pdf_parser.detect_volume_number(fname, parsed_res['metadata']['title'])
                else:
                    parsed_res = epub_parser.parse_single_epub(data, fname)
                    vol_num = epub_parser.detect_volume_number(fname, parsed_res['metadata']['title'])
                parsed_files.append({
                    'filename': fname,
                    'volume_number': vol_num,
                    'data': parsed_res
                })
            except Exception as ex:
                self.send_json({"error": f"Failed to parse {fname}: {str(ex)}"}, status=400)
                return

        # If client did not provide an explicit order_map, sort by detected volume number, then natural sort filename
        if not order_map:
            parsed_files.sort(key=lambda x: (x['volume_number'] if x['volume_number'] is not None else 9999, natural_sort_key(x['filename'])))

        conn = database.get_db()
        cur = conn.cursor()
        now = time.time()

        # Determine novel
        if novel_id:
            # Adding volumes to existing novel
            cur.execute("SELECT * FROM novels WHERE id = ? AND user_id = ?", (novel_id, user_id))
            target_novel = cur.fetchone()
            if not target_novel:
                self.send_json({"error": "Target novel not found"}, status=404)
                conn.close()
                return
            novel_title = target_novel["title"]
        else:
            # Create new novel
            first_meta = parsed_files[0]['data']['metadata']
            first_fname = parsed_files[0]['filename']
            if custom_series_title and custom_series_title.strip():
                novel_title = custom_series_title.strip()
            else:
                novel_title = epub_parser.extract_base_novel_title(first_meta['title'], first_fname)

            novel_id = f"nov_{uuid.uuid4().hex[:12]}"
            cover_data = first_meta.get('cover_data')
            cur.execute("""
                INSERT INTO novels (id, title, author, description, cover_data, user_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                novel_id,
                novel_title,
                first_meta.get('author', 'Unknown Author'),
                first_meta.get('description', ''),
                cover_data,
                user_id,
                now,
                now
            ))

        # Check existing volumes and chapters count for deduplication and indexing
        cur.execute("SELECT COUNT(*) as v_count FROM volumes WHERE novel_id = ?", (novel_id,))
        existing_vol_count = cur.fetchone()["v_count"]

        cur.execute("SELECT id, volume_id, chapter_index, global_index, title, content_html FROM chapters WHERE novel_id = ?", (novel_id,))
        existing_chapters = [dict(r) for r in cur.fetchall()]

        # Build deduplication lookup maps
        existing_vol_ch_nums = {}
        existing_norm_titles = {}
        existing_fingerprints = {}

        for ech in existing_chapters:
            c_num = epub_parser.extract_chapter_number(ech["title"])
            if c_num is not None:
                existing_vol_ch_nums[(ech["volume_id"], c_num)] = ech
            n_title = epub_parser.normalize_title(ech["title"])
            if n_title:
                existing_norm_titles[n_title] = ech
            fp = epub_parser.compute_chapter_fingerprint(ech["content_html"])
            if fp and len(fp) >= 30:
                existing_fingerprints[fp] = ech

        volumes_added = 0
        chapters_added = 0
        duplicates_skipped = 0

        for pf in parsed_files:
            v_num = existing_vol_count + volumes_added + 1
            vol_id = f"vol_{uuid.uuid4().hex[:12]}"
            meta = pf['data']['metadata']
            raw_title = meta.get('title') or pf['filename']
            v_title = f"Volume {v_num}: {raw_title}" if "volume" not in raw_title.lower() else raw_title

            ch_list = pf['data']['chapters']
            vol_ch_count = 0

            # Insert volume row first
            cur.execute("""
                INSERT INTO volumes (id, novel_id, volume_number, title, file_name, total_chapters, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (vol_id, novel_id, v_num, v_title, pf['filename'], len(ch_list), now))

            for ch in ch_list:
                ch_num = epub_parser.extract_chapter_number(ch["title"])
                ch_norm_title = epub_parser.normalize_title(ch["title"])
                ch_fp = epub_parser.compute_chapter_fingerprint(ch["content_html"])

                # Check if chapter is already in this novel
                is_duplicate = False
                if ch_fp and len(ch_fp) >= 30 and ch_fp in existing_fingerprints:
                    is_duplicate = True
                elif ch_norm_title and ch_norm_title in existing_norm_titles:
                    ech = existing_norm_titles[ch_norm_title]
                    is_generic = bool(re.match(r'^(?:chapter|ch|c)[\s._-]*\d+$', ch_norm_title, re.I))
                    if not is_generic:
                        is_duplicate = True
                    elif ech.get("volume_id") == vol_id:
                        is_duplicate = True
                elif ch_num is not None and (vol_id, ch_num) in existing_vol_ch_nums:
                    is_duplicate = True

                if is_duplicate:
                    duplicates_skipped += 1
                    continue

                ch_id = f"ch_{uuid.uuid4().hex[:12]}"
                cur.execute("""
                    INSERT INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    ch_id,
                    novel_id,
                    vol_id,
                    ch['chapter_index'],
                    999999,
                    ch['title'],
                    ch['content_html'],
                    ch['word_count']
                ))
                new_ech = {"id": ch_id, "volume_id": vol_id, "title": ch["title"], "content_html": ch["content_html"]}
                if ch_num is not None:
                    existing_vol_ch_nums[(vol_id, ch_num)] = new_ech
                if ch_norm_title:
                    existing_norm_titles[ch_norm_title] = new_ech
                if ch_fp and len(ch_fp) >= 30:
                    existing_fingerprints[ch_fp] = new_ech

                chapters_added += 1
                vol_ch_count += 1

            volumes_added += 1

        # Re-sequence all chapters for this novel to ensure clean, strictly continuous global_index 1..N
        cur.execute("""
            SELECT c.id, c.title, c.chapter_index, c.volume_id, v.volume_number, c.rowid
            FROM chapters c
            LEFT JOIN volumes v ON c.volume_id = v.id
            WHERE c.novel_id = ?
            ORDER BY v.volume_number ASC, c.rowid ASC
        """, (novel_id,))
        all_novel_chapters = [dict(r) for r in cur.fetchall()]

        def chapter_sort_key(item):
            v_num = item.get("volume_number") or 1
            c_num = epub_parser.extract_chapter_number(item["title"])
            rowid = item.get("rowid") or 0
            if c_num is not None:
                return (v_num, 0, c_num, rowid)
            return (v_num, 1, rowid)

        all_novel_chapters.sort(key=chapter_sort_key)

        for new_global_idx, ch_row in enumerate(all_novel_chapters, start=1):
            cur.execute("UPDATE chapters SET global_index = ? WHERE id = ?", (new_global_idx, ch_row["id"]))

        # Update each volume's total_chapters to match non-duplicate count
        cur.execute("""
            UPDATE volumes
            SET total_chapters = (SELECT COUNT(*) FROM chapters WHERE volume_id = volumes.id)
            WHERE novel_id = ?
        """, (novel_id,))

        # Initialize progress if novel has none
        cur.execute("SELECT id FROM reading_progress WHERE novel_id = ? AND user_id = ?", (novel_id, user_id))
        if not cur.fetchone():
            cur.execute("SELECT id, volume_id FROM chapters WHERE novel_id = ? ORDER BY global_index ASC LIMIT 1", (novel_id,))
            first_c = cur.fetchone()
            if first_c:
                cur.execute("""
                    INSERT INTO reading_progress (id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (f"prog_{uuid.uuid4().hex[:12]}", user_id, novel_id, first_c["volume_id"], first_c["id"], 0, 0.0, now))

        conn.commit()
        conn.close()

        self.send_json({
            "success": True,
            "novel_id": novel_id,
            "novel_title": novel_title,
            "volumes_added": volumes_added,
            "chapters_added": chapters_added,
            "duplicates_skipped": duplicates_skipped,
            "total_chapters": len(all_novel_chapters)
        })

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        import socket as s
        self.socket.setsockopt(s.SOL_SOCKET, s.SO_REUSEADDR, 1)
        if hasattr(s, 'SO_REUSEPORT'):
            try:
                self.socket.setsockopt(s.SOL_SOCKET, s.SO_REUSEPORT, 1)
            except Exception:
                pass
        super().server_bind()

def run(port=PORT, host="0.0.0.0"):
    database.init_db()
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    with ThreadedHTTPServer((host, port), NovelReaderHandler) as httpd:
        print(f"=== KuroYomi Web Novel Server ===")
        print(f"Server running at: http://{host}:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("Server shutting down.")

if __name__ == "__main__":
    run()
