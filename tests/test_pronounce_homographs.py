import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import pronounce


class Homographs(unittest.TestCase):
    def test_cases(self):
        f = pronounce.fix
        self.assertIn("led", f("The pipe was made of lead."))
        self.assertIn("lead the way", f("She will lead the way."))
        self.assertIn("red", f("She read it yesterday."))
        self.assertNotIn("red", f("I read books every day."))
        self.assertIn("mynute details", f("The minute details."))
        self.assertIn("a minute", f("Wait a minute."))
        self.assertIn("bas fish", f("A bass fish."))


if __name__ == "__main__":
    unittest.main()
