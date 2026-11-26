"""The phone audio tank: read-aloud audio kept on the phone, sized from how much he listens.

Step 1 of the BYoB hybrid plan (2026-11-26): about 2 days of his last 2 weeks' listening, never less
than 30 minutes, filled on Wi-Fi only unless he allows mobile data, each clip under the engine that
really made it. These run the real public/js/tank.js and tts.js in Node with an in-memory IndexedDB.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "tank_harness.js")
PUBLIC = os.path.join(HERE, "..", "public")
NODE = shutil.which("node")


def run(scenario):
    out = subprocess.run([NODE, HARNESS, scenario], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise AssertionError("harness failed (%s): %s" % (scenario, out.stderr[-1500:]))
    return json.loads(out.stdout.strip().splitlines()[-1])


def read(*parts):
    with open(os.path.join(PUBLIC, *parts), encoding="utf-8") as f:
        return f.read()


@unittest.skipIf(NODE is None, "node is not installed on this machine")
class PhoneTankTests(unittest.TestCase):
    def test_size_follows_listening(self):
        r = run("sizing")
        self.assertEqual(r["heavy"], 7200, "an hour a day for two weeks should keep 2 hours")
        self.assertEqual(r["empty"], 1800, "never less than 30 minutes")
        self.assertEqual(r["light"], 1800)
        self.assertEqual(r["huge"], 43200, "capped at 12 hours")
        self.assertEqual(r["oldOnly"], 1800, "listening older than 2 weeks no longer counts")
        self.assertEqual(r["pruned"], 1)
        self.assertGreaterEqual(r["logged"], 10)
        self.assertEqual(r["ignoredJump"], 0, "a seek is not listening")

    def test_eviction_order(self):
        r = run("sizing")
        self.assertEqual(r["evictFits"], ["stale"], "only stale audio goes when the tank fits")
        self.assertEqual(r["evictTight"], ["stale", "played-old", "played-new"],
                         "played audio goes oldest first; audio still ahead and protected audio stay")

    def test_wifi_only_unless_mobile_data_allowed(self):
        r = run("sizing")
        self.assertEqual(r["wifi"], "full")
        self.assertEqual(r["cell"], "lookahead")
        self.assertEqual(r["cellAllowed"], "full")
        self.assertEqual(r["iphone"], "lookahead", "iPhone cannot say Wi-Fi, so it counts as mobile data")
        self.assertEqual(r["iphoneAllowed"], "full")
        self.assertEqual(r["saveData"], "lookahead", "Low Data Mode always wins")

    def test_storage_round_trip(self):
        r = run("storage")
        self.assertTrue(r["put"])
        self.assertFalse(r["tiny"], "an empty answer is never stored")
        self.assertEqual(r["gotSize"], 5000)
        self.assertTrue(r["reloaded"], "the list of clips must come back after a reload")
        self.assertEqual(r["trimmed"], 1)
        self.assertFalse(r["afterTrim"])
        self.assertEqual(r["afterClear"], 0)

    def test_stored_clip_plays_without_network(self):
        r = run("tts-hit")
        self.assertTrue(r["url"])
        self.assertEqual(r["fetched"], [])

    def test_clips_saved_under_the_engine_that_made_them(self):
        r = run("tts-save")
        self.assertTrue(r["kokoroKeySaved"])
        self.assertFalse(r["fallbackUnderKokoro"], "an Edge fallback must never be stored as Kokoro")
        self.assertTrue(r["fallbackUnderEdge"])

    def test_pc_copy_plays_when_the_pc_drops(self):
        r = run("tts-offline")
        self.assertTrue(r["url"])
        self.assertEqual(r["fetched"], [], "the stored Kokoro clip should play before asking Edge")
        self.assertEqual(r["engineActive"], "kokoro")

    def test_fill_goes_to_disk_not_memory(self):
        r = run("tts-fill")
        self.assertEqual(r["stored"], 29, "every line after the current one is stored ahead")
        self.assertEqual(r["blobCache"], 0, "a tank fill must not hold audio in memory")

    def test_warns_once_when_low_and_when_it_runs_out(self):
        r = run("tts-low")
        self.assertEqual(r["onlineToasts"], 0, "with signal nothing is low: it keeps fetching")
        self.assertEqual(len(r["lowToasts"]), 1, "one warning per outage, not one every check")
        self.assertIn("running low", r["lowToasts"][0])
        self.assertEqual(len(r["allToasts"]), 2)
        self.assertIn("ran out", r["allToasts"][1])
        self.assertFalse(r["resetLow"], "signal back re-arms the warning")

    def test_mobile_data_is_off_by_default(self):
        r = run("sizing")
        self.assertEqual(r["iphone"], "lookahead")
        self.assertIn("data-tank-cellular", read("index.html"))
        self.assertNotIn('data-tank-cellular style="width: 20px; height: 20px; accent-color: var(--accent); cursor: pointer;" checked', read("index.html"))

    def test_no_fill_on_unknown_connection_by_default(self):
        r = run("tts-nofill")
        self.assertEqual(r["stored"], 0)
        self.assertEqual(r["storedAllowed"], 29)


class PhoneTankWiringTests(unittest.TestCase):
    def test_loaded_cached_and_in_settings(self):
        index = read("index.html")
        sw = read("sw.js")
        stamp = re.search(r"const ASSET_VERSION = '([0-9.]+)'", sw).group(1)
        self.assertIn("/js/tank.js?v=%s" % stamp, index)
        self.assertLess(index.index("/js/tank.js"), index.index("/js/tts.js"), "tank.js must load before tts.js")
        self.assertIn("'/js/tank.js?v=' + ASSET_VERSION", sw)
        for attr in ("data-tank-status", "data-tank-cellular", "data-tank-clear", "data-tank-alerts"):
            self.assertIn(attr, index)
        self.assertIn("Keep audio on this phone", index)
        self.assertIn("Use mobile data to fill", index)
        self.assertIn("Clear stored audio", index)

    def test_no_emoji(self):
        text = read("js", "tank.js")
        self.assertIsNone(re.search(u"[\U0001F300-\U0001FAFF☀-➿]", text))


if __name__ == "__main__":
    unittest.main()
