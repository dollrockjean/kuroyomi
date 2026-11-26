"""Read aloud keeps going in the background, the saved spot is the line he sees, and a fresh tap wins sync (2026-11-25)."""
import os
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "public", "js")


def src(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


class BackgroundTest(unittest.TestCase):
    def test_cloud_failure_in_background_holds_audio_instead_of_device_voice(self):
        js = src("tts.js")
        self.assertIn("holdInBackgroundInsteadOfDevice(index, why)", js)
        body = js[js.index("holdInBackgroundInsteadOfDevice(index, why) {"):]
        body = body[:body.index("\n  },")]
        self.assertIn("document.hidden", body)
        self.assertIn("this.holdAudioSession()", body)
        self.assertNotIn("speakWithDeviceVoice", body)
        # both fallback paths go through it before the device voice
        self.assertEqual(js.count("this.holdInBackgroundInsteadOfDevice("), 2)

    def test_log_reaches_the_server(self):
        self.assertIn("'/api/tts/log'", src("tts.js"))
        with open(os.path.join(ROOT, "..", "..", "server.py"), encoding="utf-8") as f:
            server = f.read()
        self.assertIn('if path == "/api/tts/log":', server)
        self.assertIn('"/api/tts/log",', server)  # behind the sync-key check

    def test_stale_build_rescue_never_reloads_under_read_aloud(self):
        js = src("app.js")
        body = js[js.index("async rescueStaleBuild()"):]
        body = body[:body.index("window.location.reload()")]
        self.assertGreaterEqual(body.count("TTSEngine.isPlaying"), 2)


class SpotTest(unittest.TestCase):
    def test_spot_is_first_paragraph_under_the_top_bar(self):
        js = src("reader.js")
        self.assertIn("getTopVisibleParagraph()", js)
        self.assertNotIn("window.innerHeight * 0.4", js)
        self.assertIn("this.scrollParagraphToTop(el)", js)

    def test_read_aloud_starts_on_the_list_index_he_sees(self):
        self.assertIn("window.Reader.getVisibleParagraphListIndex()", src("tts.js"))


class SyncTest(unittest.TestCase):
    def test_a_fresh_change_is_resent_not_reverted(self):
        js = src("sync.js")
        self.assertIn("tappedJustNow", js)
        self.assertIn("client_updated_at: serverAt + 0.01", js)


if __name__ == "__main__":
    unittest.main()
