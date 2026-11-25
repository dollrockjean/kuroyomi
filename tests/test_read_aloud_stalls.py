"""Read aloud must never sit on one line forever, and the phone's own voice must actually speak.

On 2026-11-25 (build 55.6, iPhone 16 Pro Max, home-screen app) Edge read aloud froze on a line that
was only "…": it normalized to nothing, the cloud voice got an empty request, the app fell back to
the device voice with an empty utterance, and iOS never ends an empty utterance. The device voice
itself never made a sound on the iPhone either: iOS only speaks once speak() has run inside a tap,
it drops an utterance spoken in the same moment as cancel(), and it can sit paused.

These run the real public/js/tts.js in Node with a fake audio element, server and speechSynthesis.
"""
import json
import os
import shutil
import subprocess
import unittest

HARNESS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "read_aloud_harness.js")
NODE = shutil.which("node")


def run(scenario):
    out = subprocess.run([NODE, HARNESS, scenario], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise AssertionError("harness failed (%s): %s" % (scenario, out.stderr[-1500:]))
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipIf(NODE is None, "node is not installed on this machine")
class ReadAloudStallTests(unittest.TestCase):
    def test_ellipsis_line_is_skipped_with_the_cloud_voice(self):
        r = run("ellipsis-edge")
        self.assertEqual(r["afterEllipsis"], 2, "playback did not get past the '…' line")
        self.assertEqual(r["fetched"], ["Hello there.", "Next line."])
        self.assertFalse(r["usedDeviceVoice"], "an empty line must not knock it onto the device voice")
        self.assertEqual(r["spoken"], [])

    def test_ellipsis_and_dash_lines_are_skipped_by_the_device_voice(self):
        r = run("ellipsis-device")
        self.assertEqual(r["spoken"], ["Hello there.", "Next line."])
        self.assertEqual(r["fetched"], [])

    def test_device_voice_that_never_ends_is_timed_out(self):
        r = run("device-never-ends")
        self.assertEqual(r["beforeTimeout"], 0)
        self.assertEqual(r["afterTimeout"], 1, "a device utterance that never ends held playback")
        self.assertEqual(r["spoken"], ["First line here.", "Second line here."])
        self.assertTrue(r["events"])

    def test_a_fetch_that_never_answers_is_timed_out(self):
        r = run("fetch-hangs")
        self.assertEqual(r["beforeTimeout"], 0)
        self.assertEqual(r["afterTimeout"], 1)
        self.assertIn("After the stuck line.", r["fetched"])

    def test_a_play_that_never_starts_is_timed_out(self):
        r = run("play-hangs")
        self.assertEqual(r["afterTimeout"], 1)

    def test_a_long_line_that_is_really_playing_is_not_cut_off(self):
        r = run("long-line-plays")
        self.assertEqual(r["index"], 0)
        self.assertEqual(r["events"], [])

    def test_device_voice_on_ios(self):
        r = run("device-ios")
        self.assertEqual(r["voicesAtStart"], 0)
        self.assertEqual(r["voicesAfterEvent"], 3, "voiceschanged was not listened to")
        self.assertTrue(r["primed"], "the play tap did not unlock speech")
        self.assertTrue(r["primerSpoken"])
        self.assertEqual([s["text"] for s in r["spoken"]], ["Phone voice line one.", "Phone voice line two."])
        self.assertEqual(r["spoken"][0]["voice"], "Samantha", "should pick an English on-device voice")
        self.assertEqual(r["droppedSpeaks"], [], "an utterance was spoken into a cancel or a paused synth")
        self.assertTrue(r["resumed"], "a paused synthesizer was not resumed")
        self.assertTrue(r["notAllowedPaused"], "a refused device voice must pause and ask for a tap")
        self.assertEqual(r["notAllowedIndex"], 0, "a refused device voice raced on through the chapter")


class SpeakableTextTests(unittest.TestCase):
    def test_tts_skips_unspeakable_lines_in_every_path(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "js", "tts.js"),
                   encoding="utf-8").read()
        self.assertIn("isSpeakable(text)", src)
        self.assertIn("if (!this.isSpeakable(textToSpeak))", src)
        self.assertIn("if (!this.isSpeakable(cleanDeviceText))", src)
        reader = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "js", "reader.js"),
                      encoding="utf-8").read()
        self.assertIn("isSpeakable", reader)


if __name__ == "__main__":
    unittest.main()
