"""BYoB keeper: the durable copy of Rocco's library, reading spots and settings.

Render's free server forgets everything when it restarts. This script runs every few minutes on a computer that
stays on (his Windows PC). Each run it:
  1. pings the server (keeps it awake),
  2. copies any new or changed book, every reading spot and the settings into its own folder,
  3. if the server restarted and lost books, sends them back, with the newest reading spots and settings.
A book deleted in the app while the server stayed up is moved to deleted/ and not sent back.

Standard library only. Config: <data dir>/keeper.json  {"base_url", "user_id", "sync_key", "device_token"}
Run:  python byob_keeper.py [--data DIR] [--once] [--seed BACKUP.json]
"""
import argparse
import datetime
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_DIR = os.path.join(os.path.expanduser("~"), "BYoB Backups", "keeper")


def log(data_dir, msg):
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line)
    try:
        with open(os.path.join(data_dir, "keeper.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
        p = os.path.join(data_dir, "keeper.log")
        if os.path.getsize(p) > 2_000_000:
            shutil.move(p, p + ".1")
    except OSError:
        pass


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


class Keeper:
    def __init__(self, data_dir):
        self.dir = data_dir
        os.makedirs(os.path.join(data_dir, "books"), exist_ok=True)
        os.makedirs(os.path.join(data_dir, "deleted"), exist_ok=True)
        self.cfg = read_json(os.path.join(data_dir, "keeper.json"), {})
        for k in ("base_url", "user_id", "sync_key"):
            if not self.cfg.get(k):
                raise SystemExit(f"keeper.json is missing {k}")
        self.base = self.cfg["base_url"].rstrip("/")
        self.uid = self.cfg["user_id"]
        self.state = read_json(os.path.join(data_dir, "state.json"), {})
        self.progress = read_json(os.path.join(data_dir, "progress.json"), {})
        self.settings = read_json(os.path.join(data_dir, "settings.json"), {})

    # --- http -------------------------------------------------------------
    def req(self, method, path, body=None, timeout=60):
        url = self.base + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json", "User-Agent": "BYoB-Keeper/1"}
        if self.cfg.get("device_token"):
            headers["X-Device-Token"] = self.cfg["device_token"]
        r = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def q(self, **kw):
        kw.setdefault("user_id", self.uid)
        kw.setdefault("sync_key", self.cfg["sync_key"])
        return urllib.parse.urlencode(kw)

    def link(self):
        res = self.req("POST", "/api/auth/register-device", {
            "sync_key": self.cfg["sync_key"], "device_token": self.cfg.get("device_token", ""),
            "device_name": self.cfg.get("device_name", "BYoB Keeper (PC)"), "remember": True})
        if res.get("user_id") and res["user_id"] != self.uid:
            log(self.dir, f"note: sync key belongs to {res['user_id']}, not {self.uid}; following the server")
            self.uid = res["user_id"]
        if res.get("device_token") and not self.cfg.get("device_token"):
            self.cfg["device_token"] = res["device_token"]
            write_json(os.path.join(self.dir, "keeper.json"), self.cfg)

    # --- local store ------------------------------------------------------
    def book_path(self, nid):
        return os.path.join(self.dir, "books", f"{nid}.json")

    def local_books(self):
        out = {}
        for name in os.listdir(os.path.join(self.dir, "books")):
            if name.endswith(".json"):
                b = read_json(os.path.join(self.dir, "books", name))
                if b and b.get("novels"):
                    n = b["novels"][0]
                    out[n["id"]] = {"title": n.get("title"), "chapters": len(b.get("chapters") or []),
                                    "updated_at": n.get("updated_at") or 0, "has_cover": bool(n.get("cover_data"))}
        return out

    def seed(self, backup_file):
        data = read_json(backup_file)
        if data and "idb" in data:  # browser export made by the backup job
            for db in data["idb"].values():
                for m in (db.get("library_mirror") or []):
                    self.seed_backup(m.get("backup_data") or {})
            # the app also keeps the latest spot per book in localStorage (often newer than the mirror)
            for key, raw in (data.get("localStorage") or {}).items():
                if "_prog_" not in key or "nov_" not in key:
                    continue
                try:
                    v = json.loads(raw) if isinstance(raw, str) else raw
                except ValueError:
                    continue
                if not isinstance(v, dict) or not v.get("chapterId"):
                    continue
                nid = key[key.index("nov_"):]
                if self.take_progress({"novel_id": nid, "volume_id": v.get("volumeId"), "chapter_id": v.get("chapterId"),
                                       "paragraph_index": v.get("paragraphIndex") or 0,
                                       "scroll_percent": v.get("scrollPercent") or 0,
                                       "updated_at": (v.get("savedAt") or 0) / 1000}):
                    log(self.dir, f"seeded newer reading spot for {nid} ({v.get('chapterTitle')})")
            self.save_meta()
            return
        self.seed_backup(data or {})

    def seed_backup(self, b):
        for n in b.get("novels") or []:
            if os.path.exists(self.book_path(n["id"])):
                continue
            one = {k: b.get(k) for k in ("version", "app", "user_id", "sync_key")}
            one["novels"] = [n]
            one["volumes"] = [v for v in b.get("volumes") or [] if v.get("novel_id") == n["id"]]
            one["chapters"] = [c for c in b.get("chapters") or [] if c.get("novel_id") == n["id"]]
            write_json(self.book_path(n["id"]), one)
            log(self.dir, f"seeded {n.get('title')} ({len(one['chapters'])} chapters)")
        for p in b.get("progress") or []:
            self.take_progress(p)
        s = b.get("settings") or {}
        if s and (s.get("updated_at") or 0) > (self.settings.get("updated_at") or 0):
            self.settings = s
        self.save_meta()

    def take_progress(self, p):
        nid = p.get("novel_id")
        if not nid:
            return False
        cur = self.progress.get(nid)
        if not cur or (p.get("updated_at") or 0) > (cur.get("updated_at") or 0):
            self.progress[nid] = p
            return True
        return False

    def save_meta(self):
        write_json(os.path.join(self.dir, "progress.json"), self.progress)
        write_json(os.path.join(self.dir, "settings.json"), self.settings)
        write_json(os.path.join(self.dir, "state.json"), self.state)
        day = os.path.join(self.dir, "daily", datetime.date.today().isoformat())
        os.makedirs(day, exist_ok=True)
        for name in ("progress.json", "settings.json"):
            shutil.copy2(os.path.join(self.dir, name), os.path.join(day, name))

    # --- one pass ---------------------------------------------------------
    def run_once(self):
        health = self.req("GET", "/health", timeout=120)
        boot = health.get("boot_id")
        st = self.req("GET", "/api/sync/state?" + self.q())
        if not st.get("exists"):
            self.link()
            st = self.req("GET", "/api/sync/state?" + self.q())
        elif not self.state.get("linked"):
            self.link()
            self.state["linked"] = True

        server_books = {n["id"]: n for n in st.get("novels") or []}
        local = self.local_books()
        same_boot = boot and boot == self.state.get("boot_id")
        seen_before = set(self.state.get("server_books") or [])

        # 1. pull new or changed books
        for nid, n in server_books.items():
            lb = local.get(nid)
            if (not lb or lb["chapters"] != n.get("chapter_count") or (n.get("updated_at") or 0) > lb["updated_at"] + 1
                    or bool(n.get("has_cover")) != lb["has_cover"]):
                b = self.req("GET", "/api/backup?" + self.q(novel_id=nid), timeout=300)
                if b.get("novels"):
                    if os.path.exists(self.book_path(nid)):
                        shutil.copy2(self.book_path(nid), self.book_path(nid) + ".prev")
                    b.pop("progress", None)
                    b.pop("settings", None)
                    write_json(self.book_path(nid), b)
                    log(self.dir, f"saved {n.get('title')} ({len(b.get('chapters') or [])} chapters)")

        # 2. books deleted in the app (server stayed up, book was there last run, now gone): keep a copy, do not restore
        if same_boot:
            for nid in seen_before - set(server_books):
                if os.path.exists(self.book_path(nid)):
                    shutil.move(self.book_path(nid), os.path.join(self.dir, "deleted", f"{nid}.json"))
                    log(self.dir, f"book {nid} was deleted in the app; copy moved to deleted/")

        # 3. reading spots and settings: keep the newest
        for p in st.get("progress") or []:
            self.take_progress(p)
        ss = st.get("settings") or {}
        if (ss.get("updated_at") or 0) > (self.settings.get("updated_at") or 0):
            self.settings = ss

        # 4. server lost books (restart): send them back with their newest reading spot
        restored = 0
        for nid in self.local_books():
            if nid in server_books:
                continue
            b = read_json(self.book_path(nid))
            if not b:
                continue
            b["progress"] = [self.progress[nid]] if nid in self.progress else []
            b["settings"] = {}
            self.req("POST", "/api/restore", {"user_id": self.uid, "sync_key": self.cfg["sync_key"], "backup_data": b}, timeout=600)
            restored += 1
            log(self.dir, f"restored {b['novels'][0].get('title')} to the server")
        if restored:
            st = self.req("GET", "/api/sync/state?" + self.q())
            server_books = {n["id"]: n for n in st.get("novels") or []}

        # 5. server has an older spot than we know (lost in a restart): send the newer one
        sp = {p["novel_id"]: p for p in st.get("progress") or []}
        for nid, p in self.progress.items():
            if nid not in server_books:
                continue
            if (p.get("updated_at") or 0) > (sp.get(nid, {}).get("updated_at") or 0) + 2:
                self.req("POST", "/api/progress", {
                    "user_id": self.uid, "novel_id": nid, "volume_id": p.get("volume_id"), "chapter_id": p.get("chapter_id"),
                    "paragraph_index": p.get("paragraph_index") or 0, "scroll_percent": p.get("scroll_percent") or 0,
                    "client_id": "keeper", "client_ts": (p.get("updated_at") or 0) * 1000})
                log(self.dir, f"sent newer reading spot for {nid}")
        ss = st.get("settings") or {}
        if self.settings and (self.settings.get("updated_at") or 0) > (ss.get("updated_at") or 0) + 2:
            body = {k: v for k, v in self.settings.items() if k not in ("updated_at", "extra_json")}
            try:
                body.update(json.loads(self.settings.get("extra_json") or "{}"))
            except ValueError:
                pass
            body.update({"user_id": self.uid, "client_updated_at": self.settings["updated_at"]})
            self.req("POST", "/api/settings", body)
            log(self.dir, "sent newer settings")

        self.state.update({"boot_id": boot, "server_books": sorted(server_books), "last_ok": time.time(),
                           "server_version": health.get("version")})
        self.save_meta()
        return {"books_on_server": len(server_books), "books_kept": len(self.local_books()), "restored": restored}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DEFAULT_DIR)
    ap.add_argument("--seed")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--every", type=int, default=0, help="loop forever, seconds between runs")
    a = ap.parse_args()
    k = Keeper(a.data)
    if a.seed:
        k.seed(a.seed)
    while True:
        try:
            r = k.run_once()
            log(a.data, f"ok {r}")
        except (urllib.error.URLError, OSError, ValueError) as e:
            log(a.data, f"error {type(e).__name__}: {e}")
        if not a.every:
            break
        time.sleep(a.every)


if __name__ == "__main__":
    main()
