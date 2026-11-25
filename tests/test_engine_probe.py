"""Opening the app while the BYoB server is asleep must not cost him the PC voice.

Render's free plan stops the server when nobody is reading and needs 30 to 60 seconds to answer
again. The app used to ask which engines were up exactly once at startup, give up after six seconds,
and then say "PC not reachable, using Edge" until it was hidden and brought back - with the PC
awake, the tunnel open and Kokoro idle the whole time. Reproduced live on 2026-11-24 by holding the
first answer for 45 seconds: the app made one request and never asked again.

These run the real public/js/tts.js in Node with a stubbed server, so they test the shipped code
rather than a copy of it.
"""
import json
import os
import shutil
import subprocess
import unittest

HARNESS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine_probe_harness.js")
NODE = shutil.which("node")


def run(scenario):
    out = subprocess.run([NODE, HARNESS, scenario], capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        raise AssertionError("harness failed (%s): %s" % (scenario, out.stderr[-1500:]))
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipIf(NODE is None, "node is not installed on this machine")
class EngineProbeTests(unittest.TestCase):
    def test_sleeping_server_does_not_lose_the_pc(self):
        """The first question goes unanswered, the second says the PC is there."""
        waking, later = run("cold-then-up")
        self.assertFalse(waking["usable"])
        self.assertEqual(waking["probes"], 1)
        # The app has to keep asking on its own: he is not going to leave the app and come back.
        self.assertTrue(later["usable"], "the PC never came back without the app being restarted")
        self.assertEqual(later["status"], "Your PC is speaking")

    def test_waiting_on_the_server_is_not_blamed_on_the_pc(self):
        """An unanswered question is not proof the PC is off, and must not read like it."""
        waking, later = run("never-answers")
        for moment in (waking, later):
            self.assertEqual(moment["status"], "Looking for your PC, using Edge")
            self.assertNotIn("not reachable", moment["status"])
        self.assertGreater(later["probes"], waking["probes"], "the app stopped asking")

    def test_a_pc_that_really_is_off_still_says_so(self):
        """When the server answers and says there is no PC, the old plain wording stands."""
        waking, later = run("says-pc-is-off")
        self.assertEqual(waking["status"], "PC not reachable, using Edge")
        self.assertFalse(later["usable"])
        # Still worth asking now and then: he switches the PC on in the middle of a chapter.
        self.assertGreater(later["probes"], 1)


    def test_no_account_yet_is_not_the_end_of_the_search(self):
        """Sync still connecting is not an answer about the PC, so the app must keep asking.

        The probe used to return the moment it had no account id, without arranging to ask again,
        so a launch that reached the engine question before sync finished - normal when the free
        host is waking up - left the voice switched off for the whole session (2026-11-25).
        """
        waking, later = run("no-account-yet")
        self.assertFalse(waking["usable"])
        self.assertEqual(waking["status"], "Looking for your PC, using Edge")
        self.assertTrue(later["usable"], "the app stopped asking once it had no account id")
        self.assertEqual(later["status"], "Your PC is speaking")


class EngineProbeSourceTests(unittest.TestCase):
    """Guards on the two numbers that caused it, for the day node is missing."""

    def setUp(self):
        src = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "public", "js", "tts.js")
        with open(src, encoding="utf-8") as fh:
            self.tts = fh.read()

    def test_probe_waits_longer_than_a_cold_start_of_the_free_host(self):
        self.assertIn("ENGINE_PROBE_TIMEOUT_MS: 20000", self.tts)
        self.assertNotIn("setTimeout(() => controller.abort(), 6000)", self.tts)

    def test_a_failed_probe_schedules_another(self):
        self.assertIn("scheduleEngineRetry()", self.tts)
        self.assertIn("ENGINE_RETRY_MS", self.tts)


if __name__ == "__main__":
    unittest.main()
