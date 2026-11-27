"""Headphone pause must truly stop read aloud, and headphone play must resume from the same line.

Runs the real public/js/tts.js in Node with a fake audio element, navigator.mediaSession,
fetch, and speechSynthesis across Edge, Kokoro, and device-voice paths.
"""
import json
import os
import shutil
import subprocess
import unittest

HARNESS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "headphone_pause_harness.js")
NODE = shutil.which("node")


def run(scenario):
    out = subprocess.run([NODE, HARNESS, scenario], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise AssertionError("harness failed (%s): %s" % (scenario, out.stderr[-1500:]))
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipIf(NODE is None, "node is not installed on this machine")
class HeadphonePauseTests(unittest.TestCase):
    def test_edge_background_native_pause_stops_and_headphone_play_resumes(self):
        r = run("edge-bg-native-pause")
        p = r["afterPause"]
        self.assertTrue(p["isPaused"], "background headphone pause must set isPaused=true")
        self.assertTrue(p["audioPaused"], "audio element must stay paused")
        self.assertEqual(p["playbackState"], "paused")
        self.assertEqual(p["currentIndex"], 0)
        self.assertEqual(p["extraPlays"], 0, "must not auto-retry play() after headphone pause")

        res = r["afterResume"]
        self.assertFalse(res["isPaused"])
        self.assertFalse(res["audioPaused"])
        self.assertEqual(res["playbackState"], "playing")
        self.assertEqual(res["currentIndex"], 0)

    def test_kokoro_pause_while_loading_stops_and_headphone_play_resumes(self):
        r = run("kokoro-loading-pause")
        p = r["afterPause"]
        self.assertTrue(p["isPaused"], "pause during loading must set isPaused=true")
        self.assertFalse(p["isLoading"], "pause must clear isLoading")
        self.assertTrue(p["audioPaused"], "audio must stay paused even after in-flight fetch finishes")
        self.assertEqual(p["playbackState"], "paused")
        self.assertEqual(p["currentIndex"], 0)

        res = r["afterResume"]
        self.assertFalse(res["isPaused"])
        self.assertFalse(res["audioPaused"])
        self.assertEqual(res["playbackState"], "playing")
        self.assertEqual(res["currentIndex"], 0)

    def test_kokoro_media_session_pause_and_resume(self):
        r = run("kokoro-media-pause")
        p = r["afterPause"]
        self.assertTrue(p["isPaused"])
        self.assertTrue(p["audioPaused"])
        self.assertEqual(p["playbackState"], "paused")
        self.assertEqual(p["currentIndex"], 0)

        res = r["afterResume"]
        self.assertFalse(res["isPaused"])
        self.assertFalse(res["audioPaused"])
        self.assertEqual(res["playbackState"], "playing")
        self.assertEqual(res["currentIndex"], 0)

    def test_device_voice_media_session_pause_and_resume(self):
        r = run("device-voice-pause")
        p = r["afterPause"]
        self.assertTrue(p["isPaused"])
        self.assertFalse(p["speaking"], "device speech must be cancelled on pause")
        self.assertTrue(p["deviceUtteranceNull"], "deviceUtterance must be cleared on pause")
        self.assertEqual(p["playbackState"], "paused")
        self.assertEqual(p["currentIndex"], 0)

        res = r["afterResume"]
        self.assertFalse(res["isPaused"])
        self.assertEqual(res["playbackState"], "playing")
        self.assertEqual(res["currentIndex"], 0)
        self.assertGreater(res["spokenCount"], p["spokenCount"])
        self.assertEqual(res["lastSpoken"], "First paragraph of the chapter.")

    def test_steering_wheel_media_session_handlers_preserved(self):
        r = run("media-session-handlers")
        self.assertTrue(r["hasPlay"])
        self.assertTrue(r["hasPause"])
        self.assertTrue(r["hasStop"])
        self.assertTrue(r["hasNextTrack"])
        self.assertTrue(r["hasPrevTrack"])
        self.assertIsNone(r["seekForward"])
        self.assertIsNone(r["seekBackward"])
        self.assertIsNone(r["seekTo"])


if __name__ == "__main__":
    unittest.main()
