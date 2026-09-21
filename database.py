import sqlite3
import os
import json
import time
import uuid
import re

def _resolve_db_path():
    env_path = os.environ.get("READER_DB_PATH")
    if env_path:
        return env_path
    if os.path.isdir("/data") and os.access("/data", os.W_OK):
        return "/data/reader.db"
    return os.path.join(os.path.dirname(__file__), "reader.db")

def get_db():
    conn = sqlite3.connect(_resolve_db_path(), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA cache_size = -2000")
        conn.execute("PRAGMA temp_store = FILE")
        conn.execute("PRAGMA mmap_size = 0")
    except Exception:
        pass
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    
    # Users / Sync Profiles
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        sync_key TEXT UNIQUE NOT NULL,
        display_name TEXT,
        demo_seeded INTEGER DEFAULT 0,
        created_at REAL NOT NULL,
        last_active REAL NOT NULL
    )
    """)
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN demo_seeded INTEGER DEFAULT 0")
    except Exception:
        pass
    
    # Devices (for "Remember This Device" on iOS / Web)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS devices (
        device_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        user_agent TEXT,
        is_remembered INTEGER DEFAULT 1,
        created_at REAL NOT NULL,
        last_seen REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)
    
    # Novels (Can contain single file or multiple volume files)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS novels (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT DEFAULT 'Unknown Author',
        description TEXT DEFAULT '',
        cover_data TEXT, -- Base64 data URL or path
        user_id TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)
    
    # Volumes (Each volume represents an individual .epub file in a multi-file novel)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS volumes (
        id TEXT PRIMARY KEY,
        novel_id TEXT NOT NULL,
        volume_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        total_chapters INTEGER DEFAULT 0,
        created_at REAL NOT NULL,
        FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    )
    """)
    
    # Chapters
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        novel_id TEXT NOT NULL,
        volume_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL, -- index within volume
        global_index INTEGER NOT NULL,  -- continuous index across all volumes
        title TEXT NOT NULL,
        content_html TEXT NOT NULL,
        word_count INTEGER DEFAULT 0,
        FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
        FOREIGN KEY (volume_id) REFERENCES volumes(id) ON DELETE CASCADE
    )
    """)
    
    # Reading Progress (saved exact paragraph, chapter, volume, percentage)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS reading_progress (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        novel_id TEXT NOT NULL,
        volume_id TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        paragraph_index INTEGER DEFAULT 0,
        scroll_percent REAL DEFAULT 0.0,
        updated_at REAL NOT NULL,
        UNIQUE(user_id, novel_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    )
    """)
    
    # User Settings / Preferences (theme, font, auto-scroll, TTS voice)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        theme TEXT DEFAULT 'monochrome-dark',
        font_family TEXT DEFAULT 'times',
        font_size INTEGER DEFAULT 19,
        line_height REAL DEFAULT 1.85,
        content_width TEXT DEFAULT 'normal',
        auto_scroll_speed INTEGER DEFAULT 35,
        tts_voice TEXT DEFAULT 'en-US-BrianNeural',
        tts_rate REAL DEFAULT 1.0,
        tts_pitch REAL DEFAULT 1.0,
        library_view_mode TEXT DEFAULT 'tile',
        library_sort_by TEXT DEFAULT 'last_read',
        updated_at REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)
    
    # Safe migrations for existing databases
    for col, col_type, default_val in [
        ("library_view_mode", "TEXT", "'tile'"),
        ("library_sort_by", "TEXT", "'last_read'")
    ]:
        try:
            cursor.execute(f"ALTER TABLE user_settings ADD COLUMN {col} {col_type} DEFAULT {default_val}")
        except sqlite3.OperationalError:
            pass

    conn.commit()
    conn.close()

# Helper Functions
def get_or_create_user(sync_key: str, display_name: str = None, requested_user_id: str = None):
    import hashlib
    conn = get_db()
    cur = conn.cursor()
    sync_key = (sync_key or "").strip().upper()
    now = time.time()

    # 1. If sync_key is provided and already exists in users table, return its user_id
    if sync_key:
        cur.execute("SELECT * FROM users WHERE sync_key = ?", (sync_key,))
        row = cur.fetchone()
        if row:
            cur.execute("UPDATE users SET last_active = ? WHERE id = ?", (now, row["id"]))
            conn.commit()
            conn.close()
            return row["id"]

    # 2. Derive deterministic user_id from sync_key if available
    if sync_key:
        det_hash = hashlib.sha256(sync_key.encode("utf-8")).hexdigest()[:12]
        det_user_id = f"usr_{det_hash}"
    elif requested_user_id and requested_user_id.startswith("usr_"):
        det_user_id = requested_user_id
    else:
        import secrets
        det_user_id = f"usr_{secrets.token_hex(6)}"

    # 3. Check if det_user_id exists
    cur.execute("SELECT * FROM users WHERE id = ?", (det_user_id,))
    id_row = cur.fetchone()
    if id_row:
        if sync_key and id_row["sync_key"] != sync_key:
            cur.execute("UPDATE users SET sync_key = ?, last_active = ? WHERE id = ?", (sync_key, now, det_user_id))
        else:
            cur.execute("UPDATE users SET last_active = ? WHERE id = ?", (now, det_user_id))
        conn.commit()
        conn.close()
        return det_user_id

    # 4. Insert new user row
    final_sync_key = sync_key or f"READER-{uuid.uuid4().hex[:8].upper()}"
    cur.execute(
        "INSERT OR IGNORE INTO users (id, sync_key, display_name, created_at, last_active) VALUES (?, ?, ?, ?, ?)",
        (det_user_id, final_sync_key, display_name or f"Reader_{final_sync_key[:6]}", now, now)
    )
    cur.execute(
        "INSERT OR IGNORE INTO user_settings (user_id, updated_at) VALUES (?, ?)",
        (det_user_id, now)
    )
    conn.commit()
    conn.close()
    return det_user_id

def ensure_user_exists(user_id: str, sync_key: str = None):
    """Guarantees a valid user row exists to prevent any FOREIGN KEY failures."""
    if not user_id:
        return
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        now = time.time()
        key = sync_key
        if key:
            cur.execute("SELECT id FROM users WHERE sync_key = ?", (key,))
            if cur.fetchone():
                key = None
        if not key:
            key = f"READER-{uuid.uuid4().hex[:8].upper()}"
        cur.execute("""
            INSERT OR IGNORE INTO users (id, sync_key, display_name, demo_seeded, created_at, last_active)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (user_id, key, "Reader", 1, now, now))
        cur.execute("""
            INSERT OR IGNORE INTO user_settings (user_id, updated_at)
            VALUES (?, ?)
        """, (user_id, now))
        conn.commit()
    conn.close()

def register_device(user_id: str, device_token: str, device_name: str, user_agent: str, remember: bool = True):
    conn = get_db()
    cur = conn.cursor()
    now = time.time()
    cur.execute("""
        INSERT INTO devices (device_token, user_id, device_name, user_agent, is_remembered, created_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_token) DO UPDATE SET
            user_id = excluded.user_id,
            device_name = excluded.device_name,
            user_agent = excluded.user_agent,
            is_remembered = excluded.is_remembered,
            last_seen = excluded.last_seen
    """, (device_token, user_id, device_name, user_agent, 1 if remember else 0, now, now))
    conn.commit()
    conn.close()

def get_user_by_device(device_token: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT u.*, d.device_name, d.is_remembered
        FROM devices d
        JOIN users u ON d.user_id = u.id
        WHERE d.device_token = ? AND d.is_remembered = 1
    """, (device_token,))
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE devices SET last_seen = ? WHERE device_token = ?", (time.time(), device_token))
        conn.commit()
    conn.close()
    return dict(row) if row else None

def get_user_devices(user_id: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT device_token, device_name, user_agent, is_remembered, last_seen, created_at FROM devices WHERE user_id = ? ORDER BY last_seen DESC", (user_id,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def unlink_device(user_id: str, device_token: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM devices WHERE user_id = ? AND device_token = ?", (user_id, device_token))
    conn.commit()
    conn.close()

def export_backup_data(user_id: str):
    conn = get_db()
    cur = conn.cursor()

    novels = []
    if user_id:
        cur.execute("SELECT * FROM novels WHERE user_id = ?", (user_id,))
        novels = [dict(r) for r in cur.fetchall()]

    novel_ids = [n["id"] for n in novels]
    volumes = []
    chapters = []
    if novel_ids:
        placeholders = ",".join("?" for _ in novel_ids)
        cur.execute(f"SELECT * FROM volumes WHERE novel_id IN ({placeholders})", novel_ids)
        volumes = [dict(r) for r in cur.fetchall()]

        cur.execute(f"SELECT * FROM chapters WHERE novel_id IN ({placeholders})", novel_ids)
        chapters = [dict(r) for r in cur.fetchall()]

    progress = []
    if user_id:
        cur.execute("SELECT * FROM reading_progress WHERE user_id = ?", (user_id,))
        progress = [dict(r) for r in cur.fetchall()]

    settings = {}
    sync_key = None
    if user_id:
        cur.execute("SELECT * FROM user_settings WHERE user_id = ?", (user_id,))
        settings_row = cur.fetchone()
        settings = dict(settings_row) if settings_row else {}

        cur.execute("SELECT sync_key FROM users WHERE id = ?", (user_id,))
        u_row = cur.fetchone()
        if u_row:
            sync_key = u_row["sync_key"]

    conn.close()
    return {
        "version": "1.0",
        "app": "kuroyomi",
        "exported_at": time.time(),
        "user_id": user_id,
        "sync_key": sync_key,
        "novels": novels,
        "volumes": volumes,
        "chapters": chapters,
        "progress": progress,
        "settings": settings
    }

def import_backup_data(data: dict, user_id: str, sync_key: str = None):
    import hashlib
    conn = get_db()
    cur = conn.cursor()
    now = time.time()

    owner_dict = data.get("owner") if isinstance(data.get("owner"), dict) else {}
    effective_sync_key = (sync_key or data.get("sync_key") or owner_dict.get("sync_key") or "").strip().upper()
    if effective_sync_key:
        cur.execute("SELECT id FROM users WHERE sync_key = ?", (effective_sync_key,))
        owner = cur.fetchone()
        if owner:
            # Reconcile user_id so books and progress restore directly to the owner of this sync key
            user_id = owner["id"]
        else:
            det_hash = hashlib.sha256(effective_sync_key.encode("utf-8")).hexdigest()[:12]
            det_user_id = f"usr_{det_hash}"
            user_id = det_user_id
            ensure_user_exists(user_id, sync_key=effective_sync_key)
            cur.execute("UPDATE users SET sync_key = ? WHERE id = ?", (effective_sync_key, user_id))
            conn.commit()
    else:
        ensure_user_exists(user_id)

    novels = data.get("novels", [])
    volumes = data.get("volumes", [])
    chapters = data.get("chapters", [])
    progress_list = data.get("progress", [])
    settings = data.get("settings", {})

    cur.execute("SELECT id, title FROM novels WHERE user_id = ?", (user_id,))
    existing_novels = {r["title"].strip().lower(): r["id"] for r in cur.fetchall()}
    user_has_real_books = any(not nid.startswith("nov_demo") for nid in existing_novels.values())

    # If user has real novels, remove any residual demo novel
    if user_has_real_books:
        cur.execute("DELETE FROM novels WHERE user_id = ? AND (id LIKE 'nov_demo%' OR title LIKE '%Chronicles of the Aether%')", (user_id,))
    cur.execute("UPDATE users SET demo_seeded = 1 WHERE id = ?", (user_id,))

    # Map old novel ID -> final novel ID for this user
    novel_id_remap = {}

    for n in novels:
        n_id = n.get("id", "")
        n_title = (n.get("title") or "").strip()
        # Do not inject demo novel if user already has real books
        if user_has_real_books and (n_id.startswith("nov_demo") or "chronicles of the aether" in n_title.lower()):
            continue
        # If novel with identical title already exists for this user, reuse existing novel ID
        if n_title.lower() in existing_novels and existing_novels[n_title.lower()] != n_id:
            novel_id_remap[n_id] = existing_novels[n_title.lower()]
            continue

        # Check if n_id is currently owned by another user in database
        target_nid = n_id
        cur.execute("SELECT user_id FROM novels WHERE id = ?", (n_id,))
        owner_row = cur.fetchone()
        if owner_row and owner_row["user_id"] != user_id:
            target_nid = f"nov_{uuid.uuid4().hex[:12]}"
            novel_id_remap[n_id] = target_nid
        else:
            novel_id_remap[n_id] = target_nid

        cur.execute("""
            INSERT OR REPLACE INTO novels (id, title, author, description, cover_data, user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (target_nid, n_title, n.get("author", "Unknown"), n.get("description", ""), n.get("cover_data"), user_id, n.get("created_at", now), now))
        existing_novels[n_title.lower()] = target_nid

    for p in progress_list:
        orig_nid = p.get("novel_id")
        final_nid = novel_id_remap.get(orig_nid, orig_nid)
        cur.execute("""
            INSERT OR REPLACE INTO reading_progress (id, user_id, novel_id, volume_id, chapter_id, paragraph_index, scroll_percent, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (p.get("id") or f"prog_{uuid.uuid4().hex[:12]}", user_id, final_nid, p.get("volume_id", ""), p["chapter_id"], p.get("paragraph_index", 0), p.get("scroll_percent", 0.0), now))

    if settings:
        cur.execute("""
            INSERT OR REPLACE INTO user_settings (user_id, theme, font_family, font_size, line_height, content_width, auto_scroll_speed, tts_voice, tts_rate, tts_pitch, library_view_mode, library_sort_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user_id,
            settings.get("theme", "monochrome-dark"),
            settings.get("font_family", "times"),
            settings.get("font_size", 19),
            settings.get("line_height", 1.85),
            settings.get("content_width", "normal"),
            settings.get("auto_scroll_speed", 35),
            settings.get("tts_voice", "en-US-JennyNeural"),
            settings.get("tts_rate", 1.0),
            settings.get("tts_pitch", 0.0),
            settings.get("library_view_mode", "tile"),
            settings.get("library_sort_by", "last_read"),
            now
        ))

    for v in volumes:
        orig_nid = v.get("novel_id")
        final_nid = novel_id_remap.get(orig_nid, orig_nid)
        cur.execute("""
            INSERT OR REPLACE INTO volumes (id, novel_id, volume_number, title, file_name, total_chapters, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (v["id"], final_nid, v.get("volume_number", 1), v.get("title", ""), v.get("file_name", ""), v.get("total_chapters", 0), v.get("created_at", now)))

    for c in chapters:
        orig_nid = c.get("novel_id")
        final_nid = novel_id_remap.get(orig_nid, orig_nid)
        cur.execute("""
            INSERT OR REPLACE INTO chapters (id, novel_id, volume_id, chapter_index, global_index, title, content_html, word_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (c["id"], final_nid, c["volume_id"], c.get("chapter_index", 1), c.get("global_index", 1), c.get("title", ""), c.get("content_html", ""), c.get("word_count", 0)))

    conn.commit()
    conn.close()
    return {
        "novels_restored": len(novels),
        "volumes_restored": len(volumes),
        "chapters_restored": len(chapters)
    }

def update_novel_cover(novel_id: str, user_id: str, cover_data: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("UPDATE novels SET cover_data = ?, updated_at = ? WHERE id = ? AND user_id = ?", (cover_data, time.time(), novel_id, user_id))
    conn.commit()
    conn.close()
    return True

def clean_novel_obfuscation(novel_id: str, user_id: str):
    """
    Cleans filter-dotted words across all chapters of a given novel.
    Returns the count of cleaned chapters.
    """
    import epub_parser
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id FROM novels WHERE id = ? AND user_id = ?", (novel_id, user_id))
    if not cur.fetchone():
        conn.close()
        return {"error": "Novel not found or unauthorized", "cleaned_chapters": 0}

    cur.execute("SELECT id, content_html FROM chapters WHERE novel_id = ?", (novel_id,))
    rows = cur.fetchall()
    cleaned_count = 0
    now = time.time()
    for r in rows:
        ch_id = r["id"]
        raw_html = r["content_html"] or ""
        cleaned_html = epub_parser.deobfuscate_censored_words(raw_html)
        if cleaned_html != raw_html:
            plain = re.sub(r'<[^>]+>', ' ', cleaned_html)
            wc = len(plain.split())
            cur.execute("UPDATE chapters SET content_html = ?, word_count = ? WHERE id = ?", (cleaned_html, wc, ch_id))
            cleaned_count += 1

    cur.execute("UPDATE novels SET updated_at = ? WHERE id = ?", (now, novel_id))
    conn.commit()
    conn.close()
    return {"success": True, "cleaned_chapters": cleaned_count, "total_chapters": len(rows)}
