"""BYoB Kokoro voice server: runs on Rocco's PC graphics card and speaks paragraphs as MP3.

Why it exists: Edge TTS is free but unofficial and a bit flat over hours. Kokoro-82M is an open model
that sounds more like a narrator and costs nothing to run here. The reader app asks this server first
and falls straight back to Edge (through Render) whenever the PC is off, asleep or slow.

What it does
  GET  /health                      -> {"ok": true, "device": "cuda", "voices": [...], ...}
  GET  /tts?text=&voice=&pitch=     -> audio/mpeg, Content-Length, byte ranges (iOS Safari needs both)
  POST /prefetch {"texts": [...]}   -> renders those paragraphs into the cache in the background, returns at once
  GET  /voices                      -> the narrator voices worth offering

Speed comes from three things: the model stays loaded, finished MP3s are cached on disk, and the app
prefetches the next paragraphs so almost every request is a cache hit and costs only the download.

Standard library plus kokoro-onnx, onnxruntime-gpu, lameenc, numpy. No network calls, no accounts.
Run: python kokoro_server.py [--port 8766] [--models DIR] [--cpu] [--token SECRET]
"""
import argparse
import hashlib
import json
import os
import re
import site
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVER_VERSION = "kokoro-1.0"
DEFAULT_PORT = 8766
HOME = os.path.expanduser("~")
DEFAULT_DATA = os.path.join(HOME, "BYoB Backups", "kokoro")
MAX_TEXT = 6000
CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024  # 3 GB of narrated paragraphs
CACHE_TARGET_BYTES = 2 * 1024 * 1024 * 1024
MP3_BITRATE = 48  # kbps mono: speech-clean and ~6 KB per second of audio over cellular

# Edge voice -> closest Kokoro narrator, so a saved Edge voice keeps roughly the same character.
EDGE_TO_KOKORO = {
    "en-US-BrianNeural": "am_michael",
    "en-US-BrianMultilingualNeural": "am_michael",
    "en-US-AndrewNeural": "am_adam",
    "en-US-ChristopherNeural": "am_eric",
    "en-US-AvaNeural": "af_heart",
    "en-US-AvaMultilingualNeural": "af_heart",
    "en-US-EmmaNeural": "af_nicole",
    "en-US-EmmaMultilingualNeural": "af_nicole",
    "en-GB-RyanNeural": "bm_george",
    "en-GB-SoniaNeural": "bf_emma",
    "en-AU-WilliamMultilingualNeural": "bm_lewis",
}

# The ones worth putting in front of him. name/desc match the app's voice list style.
KOKORO_VOICES = [
    {"id": "am_michael", "name": "Michael", "desc": "Warm American narrator (default)"},
    {"id": "am_adam", "name": "Adam", "desc": "Steady American"},
    {"id": "am_eric", "name": "Eric", "desc": "Deeper American"},
    {"id": "am_fenrir", "name": "Fenrir", "desc": "Dark, heavy American"},
    {"id": "am_puck", "name": "Puck", "desc": "Lively American"},
    {"id": "am_onyx", "name": "Onyx", "desc": "Low and calm"},
    {"id": "af_heart", "name": "Heart", "desc": "Expressive American"},
    {"id": "af_bella", "name": "Bella", "desc": "Rich American"},
    {"id": "af_nicole", "name": "Nicole", "desc": "Soft, close-mic American"},
    {"id": "af_aoede", "name": "Aoede", "desc": "Clear American"},
    {"id": "bm_george", "name": "George", "desc": "Classic British"},
    {"id": "bm_fable", "name": "Fable", "desc": "Storybook British"},
    {"id": "bm_lewis", "name": "Lewis", "desc": "Gravelly British"},
    {"id": "bf_emma", "name": "Emma", "desc": "Refined British"},
    {"id": "bf_isabella", "name": "Isabella", "desc": "Bright British"},
]
VALID_KOKORO = {v["id"] for v in KOKORO_VOICES}
DEFAULT_VOICE = "am_michael"

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])[\"'”’)\]]*\s+")


def log(msg):
    print("%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg), flush=True)


def add_cuda_dlls_to_path():
    """The pip nvidia-* packages ship the CUDA and cuDNN DLLs, but nothing puts their folders on the
    search path, so cuDNN's own loader cannot find its plugin DLLs. Put every nvidia/*/bin on PATH."""
    roots = []
    for d in list(site.getsitepackages()) + [os.path.dirname(os.path.dirname(sys.executable))]:
        roots.append(os.path.join(d, "nvidia"))
        roots.append(os.path.join(d, "Lib", "site-packages", "nvidia"))
    added = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            for sub in ("bin", os.path.join("lib", "x64")):
                p = os.path.join(root, name, sub)
                if os.path.isdir(p) and p not in added:
                    added.append(p)
                    try:
                        os.add_dll_directory(p)
                    except (OSError, AttributeError):
                        pass
    if added:
        os.environ["PATH"] = os.pathsep.join(added) + os.pathsep + os.environ.get("PATH", "")
    return added


def split_sentences(text, max_chars=420):
    """Break a paragraph into speakable pieces. Rendering piece by piece lets the first audio leave
    the PC sooner, and keeps any single model call short."""
    parts, buf = [], ""
    for piece in _SENTENCE_SPLIT.split(text):
        piece = piece.strip()
        if not piece:
            continue
        if buf and len(buf) + 1 + len(piece) > max_chars:
            parts.append(buf)
            buf = piece
        else:
            buf = (buf + " " + piece).strip()
    if buf:
        parts.append(buf)
    # A single sentence longer than max_chars still has to be cut somewhere: do it at a comma or space.
    out = []
    for p in parts:
        while len(p) > max_chars * 2:
            cut = p.rfind(", ", 0, max_chars * 2)
            if cut < max_chars // 2:
                cut = p.rfind(" ", 0, max_chars * 2)
            if cut < max_chars // 2:
                cut = max_chars * 2
            out.append(p[:cut].strip())
            p = p[cut:].strip()
        if p:
            out.append(p)
    return out or [text]


class Engine:
    """Holds the loaded model. One lock: the GPU session is not thread safe."""

    def __init__(self, models_dir, prefer_gpu=True):
        self.models_dir = models_dir
        self.lock = threading.Lock()
        self.device = "cpu"
        self.kokoro = None
        self.sample_rate = 24000
        self.load_seconds = 0.0
        self.renders = 0
        self.audio_seconds = 0.0
        self.compute_seconds = 0.0
        self._load(prefer_gpu)

    def _load(self, prefer_gpu):
        model = os.path.join(self.models_dir, "kokoro-v1.0.onnx")
        voices = os.path.join(self.models_dir, "voices-v1.0.bin")
        for p in (model, voices):
            if not os.path.exists(p):
                raise SystemExit("missing model file: %s (run install_kokoro_pc.py)" % p)
        t0 = time.time()
        if prefer_gpu:
            add_cuda_dlls_to_path()
        import onnxruntime
        if prefer_gpu:
            try:
                onnxruntime.preload_dlls()
            except Exception:  # noqa: BLE001 - older onnxruntime has no preload_dlls
                pass
        from kokoro_onnx import Kokoro

        session = None
        if prefer_gpu and "CUDAExecutionProvider" in onnxruntime.get_available_providers():
            try:
                opts = onnxruntime.SessionOptions()
                opts.log_severity_level = 3
                session = onnxruntime.InferenceSession(
                    model, sess_options=opts,
                    providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
                if "CUDAExecutionProvider" in session.get_providers():
                    self.device = "cuda"
                else:
                    session = None
            except Exception as exc:  # noqa: BLE001
                log("GPU session failed, using the processor instead: %s" % exc)
                session = None
        if session is not None:
            self.kokoro = Kokoro.from_session(session, voices)
        else:
            opts = onnxruntime.SessionOptions()
            opts.log_severity_level = 3
            opts.intra_op_num_threads = min(16, os.cpu_count() or 8)
            session = onnxruntime.InferenceSession(
                model, sess_options=opts, providers=["CPUExecutionProvider"])
            self.kokoro = Kokoro.from_session(session, voices)
            self.device = "cpu"
        self.load_seconds = time.time() - t0
        log("model loaded on %s in %.2fs" % (self.device, self.load_seconds))
        # First call compiles kernels; do it now so the first real paragraph is not the slow one.
        try:
            self.pcm("BYoB is ready.", DEFAULT_VOICE)
            log("warm-up done")
        except Exception as exc:  # noqa: BLE001
            log("warm-up failed: %s" % exc)

    def pcm(self, text, voice):
        """int16 mono samples for one piece of text."""
        import numpy as np
        with self.lock:
            t0 = time.time()
            samples, sr = self.kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
            dt = time.time() - t0
        self.sample_rate = sr
        arr = np.asarray(samples, dtype="float32")
        peak = float(abs(arr).max()) if arr.size else 0.0
        if peak > 0:
            arr = arr * (0.95 / peak) if peak > 0.95 else arr
        self.renders += 1
        self.audio_seconds += len(arr) / float(sr)
        self.compute_seconds += dt
        return (arr * 32767.0).clip(-32768, 32767).astype("int16"), sr

    def realtime_factor(self):
        if self.compute_seconds <= 0:
            return 0.0
        return round(self.audio_seconds / self.compute_seconds, 1)


def encode_mp3(pcm_chunks, sample_rate):
    import lameenc
    enc = lameenc.Encoder()
    enc.set_bit_rate(MP3_BITRATE)
    enc.set_in_sample_rate(sample_rate)
    enc.set_channels(1)
    enc.set_quality(5)
    out = bytearray()
    for chunk in pcm_chunks:
        out += enc.encode(chunk.tobytes())
    out += enc.flush()
    return bytes(out)


class Cache:
    """Finished MP3s on disk, keyed by voice plus text. A re-read costs nothing."""

    def __init__(self, directory):
        self.dir = directory
        os.makedirs(directory, exist_ok=True)
        self.lock = threading.Lock()
        self.inflight = {}
        self.writes = 0
        self.hits = 0
        self.misses = 0

    def key(self, text, voice):
        return hashlib.sha256(("%s|%s|%d" % (voice, text, MP3_BITRATE)).encode("utf-8")).hexdigest()

    def path(self, key):
        return os.path.join(self.dir, key[:2], key + ".mp3")

    def get(self, key):
        p = self.path(key)
        try:
            with open(p, "rb") as fh:
                data = fh.read()
            os.utime(p, None)
            self.hits += 1
            return data
        except OSError:
            self.misses += 1
            return None

    def put(self, key, data):
        p = self.path(key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp%d" % threading.get_ident()
        try:
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, p)
        except OSError as exc:
            log("cache write failed: %s" % exc)
            return
        self.writes += 1
        if self.writes % 200 == 0:
            threading.Thread(target=self.prune, daemon=True).start()

    def prune(self):
        files = []
        total = 0
        for root, _dirs, names in os.walk(self.dir):
            for n in names:
                if not n.endswith(".mp3"):
                    continue
                p = os.path.join(root, n)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                files.append((st.st_atime, st.st_size, p))
                total += st.st_size
        if total <= CACHE_MAX_BYTES:
            return
        files.sort()
        for _atime, size, p in files:
            try:
                os.remove(p)
                total -= size
            except OSError:
                pass
            if total <= CACHE_TARGET_BYTES:
                break
        log("cache pruned to %.0f MB" % (total / 1e6))

    def size_bytes(self):
        total = 0
        for root, _dirs, names in os.walk(self.dir):
            for n in names:
                try:
                    total += os.path.getsize(os.path.join(root, n))
                except OSError:
                    pass
        return total


class Renderer:
    def __init__(self, engine, cache):
        self.engine = engine
        self.cache = cache
        self.prefetch_lock = threading.Lock()
        self.prefetch_queue = []
        self.prefetch_seen = set()
        self.prefetch_worker = None

    def render(self, text, voice):
        """MP3 bytes for one paragraph. Shared work: two requests for the same text render once."""
        key = self.cache.key(text, voice)
        hit = self.cache.get(key)
        if hit:
            return hit, True
        with self.cache.lock:
            event = self.cache.inflight.get(key)
            if event is None:
                event = threading.Event()
                self.cache.inflight[key] = event
                owner = True
            else:
                owner = False
        if not owner:
            event.wait(timeout=120)
            return self.cache.get(key) or b"", False
        try:
            chunks = []
            sr = self.engine.sample_rate
            for piece in split_sentences(text):
                pcm, sr = self.engine.pcm(piece, voice)
                chunks.append(pcm)
            data = encode_mp3(chunks, sr)
            self.cache.put(key, data)
            return data, False
        finally:
            with self.cache.lock:
                self.cache.inflight.pop(key, None)
            event.set()

    def queue_prefetch(self, texts, voice):
        added = 0
        with self.prefetch_lock:
            for t in texts:
                key = self.cache.key(t, voice)
                if key in self.prefetch_seen or os.path.exists(self.cache.path(key)):
                    continue
                self.prefetch_seen.add(key)
                self.prefetch_queue.append((t, voice))
                added += 1
            if len(self.prefetch_seen) > 4000:
                self.prefetch_seen = set(list(self.prefetch_seen)[-1000:])
            if self.prefetch_worker is None or not self.prefetch_worker.is_alive():
                self.prefetch_worker = threading.Thread(target=self._drain, daemon=True)
                self.prefetch_worker.start()
        return added

    def _drain(self):
        while True:
            with self.prefetch_lock:
                if not self.prefetch_queue:
                    return
                text, voice = self.prefetch_queue.pop(0)
            try:
                self.render(text, voice)
            except Exception as exc:  # noqa: BLE001
                log("prefetch render failed: %s" % exc)

    def pending(self):
        with self.prefetch_lock:
            return len(self.prefetch_queue)


class Handler(BaseHTTPRequestHandler):
    server_version = "BYoB-Kokoro/1.0"
    protocol_version = "HTTP/1.1"
    engine = None
    cache = None
    renderer = None
    token = ""
    started_at = time.time()

    def log_message(self, fmt, *args):  # quieter: one line per real render, not per request
        pass

    # --- helpers ---------------------------------------------------------
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-BYoB-Token, Range")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Length, Content-Range, X-BYoB-Cache, X-BYoB-Device")

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def token_ok(self, query):
        if not self.token:
            return True
        given = self.headers.get("X-BYoB-Token") or (query.get("token", [""])[0] if query else "")
        return given == self.token

    # --- routes ----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path in ("/health", "/"):
            self.send_json({
                "ok": True,
                "service": "byob-kokoro",
                "version": SERVER_VERSION,
                "device": self.engine.device,
                "model": "kokoro-82M",
                "sample_rate": self.engine.sample_rate,
                "bitrate_kbps": MP3_BITRATE,
                "realtime_factor": self.engine.realtime_factor(),
                "renders": self.engine.renders,
                "cache_hits": self.cache.hits,
                "cache_misses": self.cache.misses,
                "prefetch_pending": self.renderer.pending(),
                "uptime_seconds": round(time.time() - self.started_at, 1),
                "needs_token": bool(self.token),
            })
            return

        if path == "/voices":
            self.send_json({"voices": KOKORO_VOICES, "default": DEFAULT_VOICE,
                            "edge_map": EDGE_TO_KOKORO})
            return

        if path == "/tts":
            if not self.token_ok(query):
                self.send_json({"error": "bad token"}, status=403)
                return
            text = (query.get("text", [""])[0] or "").strip()
            voice = query.get("voice", [DEFAULT_VOICE])[0]
            if not text:
                self.send_json({"error": "text query param required"}, status=400)
                return
            if len(text) > MAX_TEXT:
                self.send_json({"error": "text too long"}, status=413)
                return
            voice = EDGE_TO_KOKORO.get(voice, voice)
            if voice not in VALID_KOKORO:
                voice = DEFAULT_VOICE
            t0 = time.time()
            try:
                data, cached = self.renderer.render(text, voice)
            except Exception as exc:  # noqa: BLE001
                log("render failed: %s: %s" % (type(exc).__name__, exc))
                self.send_json({"error": "synthesis failed"}, status=503)
                return
            if not data:
                self.send_json({"error": "synthesis failed"}, status=503)
                return
            if not cached:
                log("rendered %d chars -> %d KB in %.2fs (%s)"
                    % (len(text), len(data) // 1024, time.time() - t0, voice))
            self.send_audio(data, cached)
            return

        self.send_json({"error": "not found"}, status=404)

    def send_audio(self, data, cached):
        total = len(data)
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            parts = rng[6:].split(",")[0].split("-")
            try:
                if parts[0] == "" and len(parts) > 1 and parts[1]:
                    start, end = max(0, total - int(parts[1])), total - 1
                else:
                    start = int(parts[0]) if parts[0] else 0
                    end = int(parts[1]) if len(parts) > 1 and parts[1] else total - 1
            except ValueError:
                start, end = 0, total - 1
            start = min(start, total - 1)
            end = min(max(end, start), total - 1)
            chunk = data[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
            self.send_header("Content-Length", str(len(chunk)))
            body = chunk
        else:
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(total))
            body = data
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "public, max-age=604800")
        self.send_header("X-BYoB-Cache", "hit" if cached else "miss")
        self.send_header("X-BYoB-Device", self.engine.device)
        self.cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            length = max(0, int(self.headers.get("Content-Length", 0)))
        except ValueError:
            length = 0
        raw = self.rfile.read(min(length, 2 * 1024 * 1024)) if length else b""

        if path != "/prefetch":
            self.send_json({"error": "not found"}, status=404)
            return
        if not self.token_ok(query):
            self.send_json({"error": "bad token"}, status=403)
            return
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self.send_json({"error": "bad json"}, status=400)
            return
        texts = [t.strip() for t in (body.get("texts") or []) if isinstance(t, str) and t.strip()]
        texts = [t[:MAX_TEXT] for t in texts[:80]]
        voice = body.get("voice") or DEFAULT_VOICE
        voice = EDGE_TO_KOKORO.get(voice, voice)
        if voice not in VALID_KOKORO:
            voice = DEFAULT_VOICE
        added = self.renderer.queue_prefetch(texts, voice)
        self.send_json({"queued": added, "pending": self.renderer.pending(),
                        "device": self.engine.device})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("KOKORO_PORT", DEFAULT_PORT)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--data", default=os.environ.get("KOKORO_DATA", DEFAULT_DATA))
    ap.add_argument("--models", default=None)
    ap.add_argument("--cpu", action="store_true", help="skip the graphics card")
    ap.add_argument("--token", default=os.environ.get("KOKORO_TOKEN", ""))
    args = ap.parse_args()

    models = args.models or os.path.join(args.data, "models")
    cache_dir = os.path.join(args.data, "cache")
    os.makedirs(args.data, exist_ok=True)

    engine = Engine(models, prefer_gpu=not args.cpu)
    cache = Cache(cache_dir)
    Handler.engine = engine
    Handler.cache = cache
    Handler.renderer = Renderer(engine, cache)
    Handler.token = args.token
    Handler.started_at = time.time()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    log("listening on http://%s:%d  device=%s  cache=%.0f MB  token=%s"
        % (args.host, args.port, engine.device, cache.size_bytes() / 1e6,
           "yes" if args.token else "no"))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("stopping")


if __name__ == "__main__":
    main()
