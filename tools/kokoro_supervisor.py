"""Keeps the BYoB Kokoro voice running and reachable from Rocco's phone.

It owns three jobs and never needs attention:
  1. runs kokoro_server.py on this PC (restarts it if it dies),
  2. publishes it with a Cloudflare tunnel (a free quick tunnel, or a named hostname if one is set up),
  3. tells the BYoB server on Render the current tunnel address, so the app can reach the PC directly.

The app always keeps Edge TTS as its fallback, so if this stops, nothing in the reader breaks: it just
goes back to the old voice. The announcement expires on the server after a couple of minutes, which is
what makes the app switch back to Edge on its own when the PC sleeps or loses its connection.

Config: <data>/config.json
  {"base_url": "https://byob-webnovel-reader.onrender.com", "user_id": "...", "device_token": "...",
   "token": "<shared secret the app sends>", "hostname": "" , "port": 8766}
Run: python kokoro_supervisor.py [--data DIR] [--once] [--no-tunnel]
"""
import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
DEFAULT_DATA = os.path.join(HOME, "BYoB Backups", "kokoro")
HERE = os.path.dirname(os.path.abspath(__file__))
ANNOUNCE_EVERY = 45          # the server treats an announcement as stale after 150s
TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
# Other BYoB accounts that should hear this PC's voice too, one reader key per line (2026-11-25: Rocco's
# iPhone lives on its own READER- account, not the keeper's, so it was told "no PC" for days while the
# keeper account was told "up"). The files stay on this PC; the keys are never logged or sent anywhere
# but the announcement to the BYoB server, which checks each one against its own account.
EXTRA_KEY_FILES = ("phone-reader-key.txt", "reader-keys.txt")


def account_id_for_key(key):
    """The account id the BYoB server derives from a sync key (database.get_or_create_user)."""
    return "usr_" + hashlib.sha256(key.strip().upper().encode("utf-8")).hexdigest()[:12]


def read_extra_keys(data_dir):
    keys = []
    for name in EXTRA_KEY_FILES:
        try:
            with open(os.path.join(data_dir, name), "r", encoding="utf-8-sig") as fh:
                for line in fh:
                    k = line.strip().upper()
                    if k and not k.startswith("#") and k not in ("OFFLINE", "DEFAULT_READER") \
                            and k not in keys:
                        keys.append(k)
        except OSError:
            pass
    return keys


CLOUDFLARED_CANDIDATES = [
    shutil.which("cloudflared") or "",
    r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
    r"C:\Program Files\cloudflared\cloudflared.exe",
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
]


def log(data_dir, msg):
    line = "%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        p = os.path.join(data_dir, "supervisor.log")
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        if os.path.getsize(p) > 2_000_000:
            shutil.move(p, p + ".1")
    except OSError:
        pass


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def claim_single_instance(port):
    """One supervisor per PC, or they fight over the same account.

    Two copies were running on 2026-11-24: each started its own quick tunnel, the second
    kokoro_server could not have port 8766 so its health check read the *first* one's server and
    looked fine, and both announced the same account - so whichever answered last owned it. When one
    copy's own tunnel went dead it called withdraw() and the phone lost Kokoro even though the other
    copy was healthy. That is the "PC not reachable" flapping.

    The lock is a socket on the port next to the voice server's, held for the life of the process:
    no stale pid file to clean up, and it releases itself if the process is killed.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port + 1))
        sock.listen(1)
    except OSError:
        sock.close()
        return None
    return sock


def find_cloudflared():
    for c in CLOUDFLARED_CANDIDATES:
        if c and os.path.exists(c):
            return c
    return None


def python_for_server(data_dir):
    """The server needs the venv that has kokoro-onnx and onnxruntime-gpu in it."""
    for cand in (
        os.path.join(data_dir, "venv", "Scripts", "python.exe"),
        os.path.join(data_dir, "venv", "bin", "python"),
        os.path.join(HOME, "claude-work", "byob", "kokoroenv", "Scripts", "python.exe"),
        os.path.join(HOME, "claude-work", "byob", "kokoroenv", "bin", "python"),
    ):
        if os.path.exists(cand):
            return cand
    return sys.executable


class Supervisor:
    def __init__(self, data_dir, want_tunnel=True):
        self.dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.cfg_path = os.path.join(data_dir, "config.json")
        self.cfg = read_json(self.cfg_path, {}) or {}
        changed = False
        if not self.cfg.get("token"):
            self.cfg["token"] = secrets.token_urlsafe(18)
            changed = True
        self.cfg.setdefault("port", 8766)
        self.cfg.setdefault("hostname", "")
        # Fill the Render details in from the keeper, which already knows them.
        keeper = read_json(os.path.join(HOME, "BYoB Backups", "keeper", "keeper.json"), {}) or {}
        for k in ("base_url", "user_id", "device_token"):
            if not self.cfg.get(k) and keeper.get(k):
                self.cfg[k] = keeper[k]
                changed = True
        if changed:
            write_json(self.cfg_path, self.cfg)
        # The account's sync key, kept only in the keeper's file and only in memory here, never
        # copied into this folder's config and never put in a URL. Without KOKORO_KEY set on Render
        # the announcement has to prove it owns the account, and this PC's device token is not a
        # registered device of it, so the sync key is the only proof it has (found 2026-11-24: every
        # announcement was answered 403 "not authorized for this account" and the phone read that as
        # "PC not reachable").
        self.sync_key = (keeper.get("sync_key") or "").strip()
        self.port = int(self.cfg["port"])
        self.token = self.cfg["token"]
        self.want_tunnel = want_tunnel
        self.server_proc = None
        self.tunnel_proc = None
        self.tunnel_url = self.cfg.get("hostname") and "https://" + self.cfg["hostname"] or ""
        self.named = bool(self.cfg.get("hostname"))
        self.last_announce_ok = 0.0

    def accounts(self):
        """Every (user_id, sync_key) this PC announces to: the keeper's account first, then each extra
        reader key on this PC (re-read every time, so a new key works without a restart)."""
        out = []
        if self.cfg.get("user_id"):
            out.append((self.cfg["user_id"], self.sync_key))
        seen = {self.cfg.get("user_id")}
        for key in read_extra_keys(self.dir):
            if key == (self.sync_key or "").strip().upper():
                continue
            uid = account_id_for_key(key)
            if uid not in seen:
                seen.add(uid)
                out.append((uid, key))
        return out

    # --- local server ----------------------------------------------------
    def server_health(self, timeout=4):
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:%d/health" % self.port,
                headers={"X-BYoB-Token": self.token})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            return None

    def ensure_server(self):
        if self.server_health():
            return True
        if self.server_proc and self.server_proc.poll() is None:
            return False  # still starting up (model load takes a few seconds)
        script = os.path.join(HERE, "kokoro_server.py")
        if not os.path.exists(script):
            log(self.dir, "kokoro_server.py not found next to the supervisor")
            return False
        py = python_for_server(self.dir)
        out = open(os.path.join(self.dir, "server.log"), "a", encoding="utf-8", errors="replace")
        self.server_proc = subprocess.Popen(
            [py, script, "--port", str(self.port), "--data", self.dir, "--token", self.token],
            stdout=out, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        log(self.dir, "started kokoro_server (pid %d) with %s" % (self.server_proc.pid, py))
        return False

    # --- second voice engine: VoiceStudio's backend (optional) ------------
    def ensure_voicestudio(self):
        """Keeps VoiceStudio's OmniVoice backend running on 127.0.0.1:3900 when it is installed in
        ~/claude-work/voicestudio. Without it the app's "Studio" voice falls back to Kokoro."""
        root = os.path.join(HOME, "claude-work", "voicestudio")
        py = os.path.join(root, ".venv", "Scripts", "python.exe")
        keyfile = os.path.join(root, "api-key.txt")
        if not (os.path.exists(py) and os.path.exists(keyfile)):
            return
        try:
            with socket.create_connection(("127.0.0.1", 3900), timeout=1):
                return
        except OSError:
            pass
        proc = getattr(self, "vs_proc", None)
        if proc and proc.poll() is None:
            return  # still starting up
        try:
            with open(keyfile, "r", encoding="utf-8") as fh:
                key = fh.read().strip()
            env = dict(os.environ, OMNIVOICE_API_KEY=key, OMNIVOICE_ANALYTICS_DISABLED="1",
                       OMNIVOICE_BIND_HOST="127.0.0.1", OMNIVOICE_PORT="3900")
            out = open(os.path.join(self.dir, "voicestudio.log"), "a", encoding="utf-8", errors="replace")
            self.vs_proc = subprocess.Popen(
                [py, os.path.join("backend", "main.py")], cwd=root, env=env,
                stdout=out, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            log(self.dir, "started VoiceStudio backend (pid %d)" % self.vs_proc.pid)
        except Exception as exc:  # noqa: BLE001 - the Studio voice just falls back to Kokoro
            log(self.dir, "VoiceStudio backend did not start: %s" % exc)

    # --- tunnel ----------------------------------------------------------
    def ensure_tunnel(self):
        if not self.want_tunnel:
            return
        if self.named:
            # A named hostname is served by the main cloudflared service; nothing to start here.
            return
        if self.tunnel_proc and self.tunnel_proc.poll() is None and self.tunnel_url:
            return
        exe = find_cloudflared()
        if not exe:
            log(self.dir, "cloudflared not installed: the PC voice stays on this computer only")
            return
        self.tunnel_url = ""
        self._tunnel_fails = 0
        # cloudflared reads ~/.cloudflared/config.yml by default. On this PC that file belongs to the
        # Hive bridge tunnel and ends in a catch-all "http_status:404", which made every quick tunnel
        # answer 404 (found 2026-11-23). An empty config of our own keeps the two apart.
        empty_cfg = os.path.join(self.dir, "quick-tunnel.yml")
        if not os.path.exists(empty_cfg):
            with open(empty_cfg, "w", encoding="utf-8") as f:
                f.write("# BYoB Kokoro quick tunnel: intentionally empty, see kokoro_supervisor.py\n")
        self.tunnel_proc = subprocess.Popen(
            [exe, "tunnel", "--config", empty_cfg, "--no-autoupdate",
             "--url", "http://127.0.0.1:%d" % self.port],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        log(self.dir, "started cloudflared (pid %d)" % self.tunnel_proc.pid)
        threading.Thread(target=self._read_tunnel_output, daemon=True).start()

    def _read_tunnel_output(self):
        proc = self.tunnel_proc
        logf = open(os.path.join(self.dir, "tunnel.log"), "a", encoding="utf-8", errors="replace")
        try:
            for line in proc.stdout:
                logf.write(line)
                logf.flush()
                m = TUNNEL_URL_RE.search(line)
                if m and m.group(0) != self.tunnel_url:
                    self.tunnel_url = m.group(0)
                    log(self.dir, "tunnel address: %s" % self.tunnel_url)
                    self.announce()
        except Exception:  # noqa: BLE001
            pass
        finally:
            logf.close()

    def tunnel_reachable(self, timeout=12):
        if not self.tunnel_url:
            return None
        try:
            req = urllib.request.Request(self.tunnel_url + "/health",
                                         headers={"User-Agent": "BYoB-Kokoro-Supervisor/1",
                                                  "X-BYoB-Token": self.token})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
            data["_rtt_ms"] = round((time.time() - t0) * 1000)
            return data
        except Exception:  # noqa: BLE001
            return None

    # --- announce --------------------------------------------------------
    def note_quiet_skip(self, why):
        """An announcement that never leaves used to return without a word, so the log looked calm
        while the phone was losing the PC voice. Say it, but at most once every ten minutes."""
        if time.time() - getattr(self, "_quiet_logged_at", 0) < 600:
            return
        self._quiet_logged_at = time.time()
        log(self.dir, "did not announce: %s" % why)

    def announce(self):
        base = (self.cfg.get("base_url") or "").rstrip("/")
        if not base or not self.cfg.get("user_id"):
            return False
        if not self.tunnel_url:
            self.note_quiet_skip("no tunnel address yet")
            return False
        health = self.server_health()
        if not health:
            self.note_quiet_skip("the local voice server did not answer /health")
            return False
        body = {
            "url": self.tunnel_url,
            # Only so a server that has no KOKORO_KEY of its own can still reach this PC. A server
            # that does have the key ignores this and checks the header below instead, which is what
            # stops a stranger pointing the app at their own machine.
            "token": self.token,
            "device": health.get("device"),
            "version": health.get("version"),
            "realtime_factor": health.get("realtime_factor"),
            "voices_url": self.tunnel_url + "/voices",
            "device_name": "BYoB Kokoro (PC)",
        }
        ok_main = False
        for n, (user_id, key) in enumerate(self.accounts()):
            one = dict(body, user_id=user_id)
            if key:
                one["sync_key"] = key
            ok = self._post_engine(base, one, "keeper account" if n == 0 else "reader account %d" % n)
            if n == 0:
                ok_main = ok
        if ok_main:
            self.last_announce_ok = time.time()
        return ok_main

    def _post_engine(self, base, body, label):
        try:
            req = urllib.request.Request(
                base + "/api/tts/engine", data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json",
                         "User-Agent": "BYoB-Kokoro-Supervisor/1",
                         "X-Kokoro-Key": self.token,
                         "X-Device-Token": self.cfg.get("device_token", "")})
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            return True
        except urllib.error.HTTPError as exc:
            log(self.dir, "announce rejected (%s): HTTP %s" % (label, exc.code))
        except Exception as exc:  # noqa: BLE001
            log(self.dir, "announce failed (%s): %s" % (label, exc))
        return False

    def withdraw(self):
        """Tell the server the PC voice is going away, so the app switches to Edge at once."""
        base = (self.cfg.get("base_url") or "").rstrip("/")
        if not base or not self.cfg.get("user_id"):
            return
        for user_id, key in self.accounts():
            gone = {"user_id": user_id, "url": ""}
            if key:
                gone["sync_key"] = key
            try:
                req = urllib.request.Request(
                    base + "/api/tts/engine",
                    data=json.dumps(gone).encode("utf-8"),
                    headers={"Content-Type": "application/json",
                             "X-Kokoro-Key": self.token,
                             "X-Device-Token": self.cfg.get("device_token", "")})
                with urllib.request.urlopen(req, timeout=15) as r:
                    r.read()
            except Exception:  # noqa: BLE001
                pass
        log(self.dir, "withdrew the PC voice")

    def write_state(self):
        health = self.server_health() or {}
        write_json(os.path.join(self.dir, "state.json"), {
            "url": self.tunnel_url,
            "token": self.token,
            "port": self.port,
            "device": health.get("device"),
            "realtime_factor": health.get("realtime_factor"),
            "server_ok": bool(health),
            "last_announce_ok": self.last_announce_ok,
            "accounts": [uid for uid, _ in self.accounts()],
            "updated": time.time(),
        })

    def check_tunnel(self):
        """A quick tunnel can stay 'connected' while the edge stops serving it. Three failed health
        checks through the public address in a row: drop it and start a fresh one (new address,
        announced again), so the phone never keeps trying a dead URL for long."""
        if self.named or not self.tunnel_url or not self.tunnel_proc:
            return
        if self.tunnel_reachable(timeout=10):
            self._tunnel_fails = 0
            return
        self._tunnel_fails = getattr(self, "_tunnel_fails", 0) + 1
        log(self.dir, "tunnel health check failed (%d in a row)" % self._tunnel_fails)
        if self._tunnel_fails >= 3:
            log(self.dir, "restarting the tunnel")
            self.withdraw()
            try:
                self.tunnel_proc.terminate()
            except Exception:  # noqa: BLE001
                pass
            self.tunnel_proc = None
            self.tunnel_url = ""

    def tick(self):
        self.ensure_server()
        self.ensure_voicestudio()
        self.check_tunnel()
        self.ensure_tunnel()
        if self.named and not self.tunnel_url:
            self.tunnel_url = "https://" + self.cfg["hostname"]
        self.announce()
        self.write_state()

    def run(self):
        log(self.dir, "supervisor starting (port %d, tunnel %s)"
            % (self.port, "named:" + self.cfg["hostname"] if self.named else "quick"))
        try:
            while True:
                try:
                    self.tick()
                except Exception as exc:  # noqa: BLE001
                    log(self.dir, "tick failed: %s: %s" % (type(exc).__name__, exc))
                time.sleep(ANNOUNCE_EVERY)
        except KeyboardInterrupt:
            pass
        finally:
            self.withdraw()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.environ.get("KOKORO_DATA", DEFAULT_DATA))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--no-tunnel", action="store_true")
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()

    sup = Supervisor(args.data, want_tunnel=not args.no_tunnel)
    if args.status:
        print(json.dumps({
            "config": {k: v for k, v in sup.cfg.items() if k != "device_token"},
            "state": read_json(os.path.join(args.data, "state.json"), {}),
            "health": sup.server_health(),
        }, indent=2))
        return 0
    # Anything that starts a tunnel or announces has to be the only copy running.
    lock = claim_single_instance(sup.port)
    if lock is None:
        log(args.data, "another supervisor is already running (lock port %d): exiting"
            % (sup.port + 1))
        return 0
    if args.once:
        sup.tick()
        time.sleep(2)
        sup.tick()
        print(json.dumps(read_json(os.path.join(args.data, "state.json"), {}), indent=2))
        return 0
    sup.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
