"""The second PC voice ("Studio", VoiceStudio's OmniVoice): PC server renders it, relay falls back to Kokoro."""
import io
import json
import os
import sys
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'tools')))
import kokoro_server as ks


def wav_bytes(seconds=0.2, sr=24000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x10\x00" * int(sr * seconds))
    return buf.getvalue()


class FakeVS(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        FakeVS.seen.append((self.path, self.headers.get("Authorization"), json.loads(self.rfile.read(n))))
        data = wav_bytes()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class StudioVoiceTests(unittest.TestCase):
    def test_voice_is_listed_and_valid(self):
        self.assertIn("vs_default", ks.VALID_KOKORO)
        self.assertIn("vs_default", [v["id"] for v in ks.KOKORO_VOICES])

    def test_vs_pcm_talks_to_voicestudio(self):
        srv = HTTPServer(("127.0.0.1", 0), FakeVS)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        old = ks.VS_URL
        ks.VS_URL = "http://127.0.0.1:%d" % srv.server_port
        os.environ["OMNIVOICE_API_KEY"] = "test-key"
        try:
            arr, sr = ks.vs_pcm("Hello there.", "vs_default")
        finally:
            ks.VS_URL = old
            os.environ.pop("OMNIVOICE_API_KEY", None)
            srv.shutdown()
        self.assertEqual(sr, 24000)
        self.assertGreater(len(arr), 1000)
        path, auth, body = FakeVS.seen[-1]
        self.assertEqual(path, "/v1/audio/speech")
        self.assertEqual(auth, "Bearer test-key")
        self.assertEqual(body["input"], "Hello there.")

    def test_relay_and_client_know_the_fallback(self):
        root = os.path.join(os.path.dirname(__file__), "..")
        src = open(os.path.join(root, "server.py"), encoding="utf-8").read()
        self.assertIn('kvoice.startswith("vs_")', src)
        self.assertIn('"kokoro-fallback"', src)
        js = open(os.path.join(root, "public", "js", "tts.js"), encoding="utf-8").read()
        self.assertIn("id: 'vs_default'", js)


if __name__ == "__main__":
    unittest.main()
