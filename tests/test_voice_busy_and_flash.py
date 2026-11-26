"""Two read-aloud bugs from 2026-11-25.

1. After about 9 minutes the voice dropped from Kokoro to Edge: look-ahead requests filled the server's
   request slots, it answered an instant 503, and the phone read that as "PC down".
2. The voice picker flashed between paragraphs: every paragraph wrote the Edge voice id into the
   Kokoro narrator list, which blanked it until the next engine update.
"""
import os
import socket
import threading
import time
import unittest
import http.server

import importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TTS = open(os.path.join(ROOT, "public", "js", "tts.js"), encoding="utf-8").read()


def load_server_class():
    """ThreadedHTTPServer without importing all of server.py (it needs pypdf and the database)."""
    src = open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()
    start = src.index("class ThreadedHTTPServer")
    end = src.index("def run(", start)
    ns = {"socketserver": __import__("socketserver"), "http": http, "threading": threading}
    exec(src[start:end], ns)
    return ns["ThreadedHTTPServer"]


class SlowHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(0.6)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class ServerWaitsForASlot(unittest.TestCase):
    def test_a_full_server_queues_instead_of_refusing(self):
        cls = load_server_class()

        class Small(cls):
            MAX_RUNNING = 2
            MAX_WAITING = 50
            SLOT_WAIT_SECONDS = 5.0
            _thread_semaphore = threading.Semaphore(2)
            _waiting_semaphore = threading.Semaphore(50)

        httpd = Small(("127.0.0.1", 0), SlowHandler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            codes = []

            def hit():
                s = socket.create_connection(("127.0.0.1", port), timeout=10)
                s.sendall(b"GET / HTTP/1.0\r\n\r\n")
                data = s.recv(100)
                s.close()
                codes.append(data.split(b" ")[1])

            ts = [threading.Thread(target=hit) for _ in range(6)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            self.assertEqual(codes.count(b"200"), 6, codes)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_the_wait_is_shorter_than_the_phones_relay_timeout(self):
        cls = load_server_class()
        self.assertLess(cls.SLOT_WAIT_SECONDS, 12)
        self.assertGreater(cls.MAX_RUNNING, 24)


class PhoneTreatsBusyAsBusy(unittest.TestCase):
    def test_busy_answers_are_retried_and_do_not_mark_the_pc_down(self):
        self.assertIn("res.status === 503 || res.status === 429) && busyTries < this.KOKORO_BUSY_RETRIES", TTS)
        self.assertIn("if (err && err.busy) {", TTS)

    def test_relay_requests_are_capped(self):
        self.assertIn("while (this._relayActive >= this.KOKORO_RELAY_MAX)", TTS)
        self.assertIn("if (this._kokoroPrefetchBusy) {", TTS)


class PickerDoesNotFlash(unittest.TestCase):
    def test_per_paragraph_update_uses_each_pickers_own_engine(self):
        body = TTS[TTS.index("  updateAudioUI() {"):]
        body = body[:body.index("this.updateSleepBadge();")]
        self.assertNotIn(".value = this.selectedVoice", body)
        self.assertIn("this.voicePickerValue(sel.dataset.engine", body)


if __name__ == "__main__":
    unittest.main()
