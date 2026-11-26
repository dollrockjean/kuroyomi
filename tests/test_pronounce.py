"""Kokoro (espeak) says heteronyms one way only; tools/pronounce.py picks the meant one."""
import json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import pronounce


class PronounceTests(unittest.TestCase):
    def check(self, text, want):
        self.assertEqual(pronounce.fix(text), want)

    def test_lead(self):
        self.check("The pipe was made of lead.", "The pipe was made of led.")
        self.check("A lead pipe.", "A led pipe.")
        self.check("She will lead the team.", "She will lead the team.")
        self.check("He took the lead.", "He took the lead.")
        self.check("Lead them out.", "Lead them out.")

    def test_read(self):
        self.check("I read the book yesterday.", "I red the book yesterday.")
        self.check("She read it twice.", "She red it twice.")
        self.check("He had read the letter.", "He had red the letter.")
        self.check("You need to read this.", "You need to read this.")
        self.check("Read the sign.", "Read the sign.")
        self.check('"I read every day," she said.', '"I read every day," she said.')

    def test_interjections(self):
        self.check('"Huh?" he said.', '"Hah?" he said.')
        self.check("Hmm... maybe. HMMM!", "Hum... maybe. HUM!")
        self.check("Uh-huh, mm-hmm. Tsk tsk! Heh.", "Uh hah, mm hum. Tisk! Hehh.")
        self.check("The hum of Hugh, a hummingbird, huh!", "The hum of Hugh, a hummingbird, hah!")
        self.check("Uh, um, well.", "Uh, um, well.")

    def test_close(self):
        self.check("Close the door.", "Cloze the door.")
        self.check("He was so close the air felt thin.", "He was so close the air felt thin.")
        self.check("Stay close.", "Stay close.")

    def test_wound_wind_dove_bow(self):
        self.check("He wound the clock.", "He wownd the clock.")
        self.check("The wound was deep.", "The wound was deep.")
        self.check("The wind howled.", "The wind howled.")
        self.check("Wind the rope.", "Wynd the rope.")
        self.check("He dove in.", "He dohv in.")
        self.check("A white dove flew.", "A white dove flew.")
        self.check("They bow down.", "They bough down.")

    def test_user_words(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "pronunciations.json")
            with open(p, "w") as f:
                json.dump({"Koromi": "Ko roh mee"}, f)
            pronounce.set_user_file(p)
            try:
                self.check("koromi smiled.", "Ko roh mee smiled.")
            finally:
                pronounce.set_user_file(None)


if __name__ == "__main__":
    unittest.main()
