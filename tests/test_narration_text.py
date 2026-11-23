"""What the voices are actually given to read.

Two things must never happen: a word-for-word reading of punctuation ("comma", "dot dot
dot"), and a language other than English. Both were real complaints, 2026-11-23.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                  "public", "js", "tts.js")


class NarrationTextTest(unittest.TestCase):
    def n(self, text):
        return server.normalize_text_for_narration(text)

    def test_ellipsis_becomes_a_pause_attached_to_the_word(self):
        self.assertEqual(self.n("He paused... then left."), "He paused, then left.")
        self.assertEqual(self.n("He paused…then left."), "He paused, then left.")
        self.assertEqual(self.n("Wait .... what?"), "Wait, what?")
        self.assertEqual(self.n("He paused..."), "He paused.")

    def test_no_floating_punctuation_is_left_to_read_out_loud(self):
        for raw in ("... and then it ended.", "…", "...", ". . .", "   ...   really?",
                    "<<...>> he said", "[...]"):
            out = self.n(raw)
            self.assertNotRegex(out, r"(?:^|\s)[,;:]+(?:\s|$)",
                                f"lone punctuation left in {out!r} (from {raw!r})")
            self.assertNotIn("...", out, f"dots left in {out!r} (from {raw!r})")
            self.assertFalse(out.startswith(","), f"leading comma in {out!r}")

    def test_an_ellipsis_only_paragraph_says_nothing_or_nothing_odd(self):
        self.assertEqual(self.n("..."), "")
        self.assertEqual(self.n("…"), "")

    def test_ordinary_prose_is_untouched(self):
        txt = "Kael drew his sword, looked at Varyn, and spoke: \"It ends here.\""
        self.assertEqual(self.n(txt), txt)

    def test_real_sentences_keep_their_words(self):
        out = self.n("Mr. Smith left at 10 a.m... and never came back.")
        self.assertIn("Mr. Smith", out)
        self.assertIn("never came back", out)
        self.assertNotIn("...", out)

    def test_decimals_and_single_dots_survive(self):
        self.assertIn("3.5", self.n("He waited 3.5 seconds."))
        self.assertEqual(self.n("Done."), "Done.")

    def test_narration_never_uses_a_language_guessing_voice(self):
        self.assertTrue(server.FORCE_ENGLISH_NARRATION)
        for multi, twin in server.MULTILINGUAL_TO_ENGLISH.items():
            self.assertEqual(server.english_only_voice(multi), twin)
            self.assertNotIn("Multilingual", server.english_only_voice(multi))
            self.assertIn(twin, server.VALID_VOICES)

    def test_a_saved_multilingual_voice_is_still_accepted(self):
        for multi in server.MULTILINGUAL_TO_ENGLISH:
            if multi.startswith(("en-US-Ava", "en-US-Emma", "en-US-Brian", "en-AU-William")):
                self.assertIn(multi, server.VALID_VOICES)

    def test_the_browser_fallback_voice_is_pinned_to_english(self):
        js = open(JS, encoding="utf-8").read()
        self.assertIn("utterance.lang = 'en-US'", js)

    def test_the_two_normalizers_use_the_same_ellipsis_rule(self):
        js = open(JS, encoding="utf-8").read()
        self.assertIn(r"(\w)\s*(?:\.{3,}|…+)\s*/g, '$1, '", js)
        self.assertNotIn("', ... '", js)
        py = open(os.path.join(os.path.dirname(JS), "..", "..", "server.py"),
                  encoding="utf-8").read()
        self.assertIn(r'r"(\w)\s*(?:\.{3,}|…+)\s*", r"\1, "', py)
        self.assertNotIn('", ... "', py)

    def test_the_voice_picker_offers_no_multilingual_voice(self):
        js = open(JS, encoding="utf-8").read()
        block = js[js.index("voices: ["):js.index("ENGLISH_ONLY_VOICE")]
        offered = re.findall(r"id: '([^']+)'", block)
        self.assertTrue(offered)
        for v in offered:
            self.assertNotIn("Multilingual", v)
            self.assertIn(v, server.VALID_VOICES, f"{v} is offered but the server refuses it")


if __name__ == "__main__":
    unittest.main(verbosity=2)
