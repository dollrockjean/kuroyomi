"""A slow launch must not leave the phone on last week's app.

The worker gave the network 1500 ms to answer a navigation and then cancelled it, serving the
cached page. Any launch slower than that kept the old page, and the old page asks for the old
/js/ files by their old address, so the app stayed old no matter how often it was restarted - the
reason Rocco's phone still said his PC voice was unreachable on 2026-11-25 with the PC, the tunnel
and the server all healthy. The slow answer is now waited for in the background: if the page really
changed it replaces the cached copy and the running app reloads into it.

These run the real public/sw.js in Node, so they test the shipped worker rather than a copy.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "stale_shell_harness.js")
NODE = shutil.which("node")


def run(scenario):
    out = subprocess.run([NODE, HARNESS, scenario], capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        raise AssertionError("harness failed (%s): %s" % (scenario, out.stderr[-1500:]))
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipIf(NODE is None, "node is not installed on this machine")
class StaleShellTests(unittest.TestCase):
    def test_a_slow_launch_still_learns_about_the_new_app(self):
        res = run("slow-and-changed")
        self.assertIn("old", res["servedOnLaunch"], "the launch should not wait on a slow network")
        self.assertIn("SHELL_UPDATED", res["toldThePage"], "the app was never told to reload")
        self.assertIn("new", res["cachedAfterwards"], "the cached page is still the old one")

    def test_an_unchanged_page_disturbs_nothing(self):
        res = run("slow-and-same")
        self.assertIn("old", res["servedOnLaunch"])
        self.assertEqual(res["toldThePage"], [], "reloaded the app for nothing")

    def test_a_quick_answer_is_served_and_kept(self):
        res = run("fast")
        self.assertIn("new", res["servedOnLaunch"])
        self.assertIn("new", res["cachedAfterwards"])

    def test_offline_still_opens_instantly_from_the_cache(self):
        res = run("offline")
        self.assertIn("old", res["servedOnLaunch"])
        self.assertEqual(res["networkCalls"], 0, "an offline launch should not touch the network")


class StaleShellSourceTests(unittest.TestCase):
    """Guards for the day node is missing, on the two things that caused it."""

    def setUp(self):
        with open(os.path.join(HERE, "..", "public", "sw.js"), encoding="utf-8") as fh:
            self.sw = fh.read()
        with open(os.path.join(HERE, "..", "public", "index.html"), encoding="utf-8") as fh:
            self.html = fh.read()

    def test_the_navigation_fetch_is_not_cancelled(self):
        self.assertNotIn("controller.abort(), 1500", self.sw)
        self.assertIn("reviseShell", self.sw)

    def test_the_app_is_told_when_the_page_changed(self):
        self.assertIn("SHELL_UPDATED", self.sw)
        with open(os.path.join(HERE, "..", "public", "js", "app.js"), encoding="utf-8") as fh:
            self.assertIn("SHELL_UPDATED", fh.read())

    def test_the_stamp_in_the_page_matches_the_worker(self):
        version = re.search(r"ASSET_VERSION\s*=\s*'([0-9.]+)'", self.sw).group(1)
        stamps = set(re.findall(r"\?v=([0-9.]+)", self.html))
        self.assertEqual(stamps, {version}, "index.html and sw.js disagree about the build")


if __name__ == "__main__":
    unittest.main()
