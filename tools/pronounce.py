"""Fixes the words Kokoro says wrong before it speaks them.

Kokoro turns text into sounds with espeak, which knows one way to say each word. English has words
spelled the same and said two ways (heteronyms), and espeak picks the same one every time: "made of
lead" comes out as "leed", "she read it yesterday" as "reed", "he dove in" as "duv" (checked on the
PC, 2026-11-25). Edge reads by context and gets these right, so this only runs for Kokoro.

How: look at the words around each one and, when the other reading is meant, swap in a spelling
espeak says correctly ("led", "red", "dohv"). Novels are mostly past tense, so "read" after a
subject is past unless something says otherwise.

Also reads <data>/pronunciations.json if it exists: {"Koromi": "Ko roh mee"} - whole-word, case
insensitive, for names and words the rules do not cover. Edits are picked up without a restart.
"""
import json
import os
import re

VERSION = "p4"  # part of the audio cache key: bump when a rule changes so old audio is redone

MODALS = {"to", "will", "would", "can", "could", "should", "must", "may", "might", "shall", "do",
          "does", "did", "don't", "didn't", "doesn't", "can't", "cannot", "won't", "wouldn't",
          "couldn't", "shouldn't", "let's", "please", "i'll", "you'll", "we'll", "they'll",
          "he'll", "she'll", "it'll", "'ll", "gonna", "wanna", "never", "always"}
DETS = {"the", "a", "an", "his", "her", "my", "your", "their", "our", "its", "this", "that",
        "these", "those", "some", "no", "every", "each", "any"}
OBJ_START = DETS | {"it", "them", "him", "me", "us", "up", "down", "off", "in", "out", "back",
                    "around", "round", "through", "tight", "tightly", "eyes", "everything"}
SUBJECTS = {"i", "he", "she", "it", "we", "they", "you", "who", "one", "everyone", "nobody"}

METAL_NEXT = {"pipe", "pipes", "poisoning", "paint", "weight", "weights", "bullet", "bullets",
              "ball", "balls", "shot", "lined", "crystal", "apron", "sinker", "sinkers", "mine",
              "ore", "soldier", "soldiers", "slug", "slugs", "sheet", "sheets", "roof", "plate"}
METAL_PREV = {"of", "molten", "solid", "pure", "melted", "with", "like", "heavy", "cold", "grey",
              "gray", "dull", "red", "white"}
NOT_METAL_NEXT = DETS | {"to", "them", "him", "her", "us", "me", "you", "the", "way", "role",
                         "singer", "character", "story", "in", "on", "from"}


HABITUAL_RE = re.compile(r"\b(every|each|always|often|usually|daily|sometimes|never|rarely|nightly)\b", re.I)
MINUTE_NEXT = {"detail", "details", "particle", "particles", "amount", "amounts", "traces", "trace",
               "fraction", "differences", "difference", "changes", "quantity", "quantities",
               "hint", "hints", "cracks", "crack", "movements", "movement", "adjustments", "flaws"}
BASS_FISH_NEXT = {"fish", "fishing", "fillet", "fillets", "lake", "boat"}
BASS_FISH_PREV = {"sea", "striped", "largemouth", "smallmouth", "caught", "catch", "catching", "grilled"}


def _cap(src, word):
    if src.isupper() and len(src) > 1:
        return word.upper()
    return word[0].upper() + word[1:] if src[0].isupper() else word


# For engines that take explicit sounds (VoiceStudio OmniVoice reads CMU phonemes in brackets) the same
# decisions are written as exact sounds instead of a respelling.
CMU = {"led": "[L EH1 D]", "red": "[R EH1 D]", "cloze": "[K L OW1 Z]", "wownd": "[W AW1 N D]",
       "wynd": "[W AY1 N D]", "dohv": "[D OW1 V]", "bough": "[B AW1]", "mynute": "[M AY0 N UW1 T]",
       "bas": "[B AE1 S]"}


def _fix_sentence(sentence, in_quote, cmu=False):
    toks = re.findall(r"[A-Za-z']+|[^A-Za-z']+", sentence)
    words = [(i, t) for i, t in enumerate(toks) if re.match(r"[A-Za-z']", t)]
    for n, (i, t) in enumerate(words):
        w = t.lower()
        prev = words[n - 1][1].lower() if n > 0 else ""
        prev2 = words[n - 2][1].lower() if n > 1 else ""
        nxt = words[n + 1][1].lower() if n + 1 < len(words) else ""
        new = None
        habitual = bool(HABITUAL_RE.search(sentence))
        if w == "lead":
            if nxt in METAL_NEXT or (prev in METAL_PREV and nxt not in NOT_METAL_NEXT
                                     and not (prev == "of" and prev2 in {"take", "took", "in"})):
                new = "led"
        elif w == "read":
            present = (prev in MODALS or prev == "" or
                       (in_quote and prev in {"i", "you", "we", "they"} and nxt not in {"it", "that"}))
            past = prev in {"had", "has", "have", "'ve", "i've", "you've", "we've", "they've",
                            "was", "were", "been", "being", "is", "are", "be", "already", "just",
                            "once", "well", "widely", "he'd", "she'd", "i'd", "they'd", "we'd"}
            if habitual:
                new = None
            elif past or (not present and (prev in SUBJECTS or prev[:1].isupper() or
                                         re.match(r"^[A-Z]", words[n - 1][1] if n else ""))):
                new = "red"
            elif not present and prev in {"and", "then", "but", "finally", "quickly", "slowly"}:
                new = "red"
        elif w == "close":
            if nxt in OBJ_START and prev not in {"so", "very", "too", "as", "quite", "get", "got",
                                                 "getting", "stay", "stayed", "came", "come",
                                                 "draw", "drew", "up", "keep", "kept", "close",
                                                 "fairly", "pretty", "dangerously"}:
                new = "cloze"
        elif w == "wound":
            if nxt in OBJ_START and prev not in DETS | {"deep", "fatal", "open", "gaping", "old",
                                                        "stab", "bullet", "knife", "head", "flesh",
                                                        "fresh", "mortal", "chest", "the"}:
                new = "wownd"
        elif w == "wind":
            if prev not in DETS | {"cold", "icy", "strong", "north", "south", "east", "west",
                                   "warm", "gentle", "fierce", "the", "of", "solar", "high",
                                   "against", "into", "in"}:
                if prev in MODALS or (nxt in OBJ_START and nxt not in {"in", "through", "around"}):
                    new = "wynd"
        elif w == "dove":
            if prev not in DETS | {"white", "grey", "gray", "mourning", "turtle", "like", "as",
                                   "peace", "little", "rock", "wild", "dove"}:
                new = "dohv"
        elif w == "minute":
            if nxt in MINUTE_NEXT:
                new = "mynute"
        elif w == "bass":
            if nxt in BASS_FISH_NEXT or prev in BASS_FISH_PREV:
                new = "bas"
        elif w == "bow":
            if nxt in {"down", "low", "deeply", "slightly", "before", "respectfully", "politely",
                       "out", "his", "her", "their", "my", "your"} or prev in MODALS | {"deep",
                                                                                      "low", "slight"}:
                new = "bough"
        if new:
            toks[i] = CMU[new] if cmu else _cap(t, new)
    return "".join(toks)


# Interjections espeak spells out letter by letter ("H-U-H"). Longest first so "uh-huh" wins over "huh".
INTERJECTIONS = [
    (r"mm+[\s-]*h?m+", "mm hum"), (r"uh[\s-]+huh", "uh hah"), (r"uh[\s-]+uh", "uh uh"),
    (r"h+m+", "hum"), (r"huh+", "hah"), (r"tsk(?:[\s-]*tsk)*", "tisk"), (r"heh+", "hehh"),
]
_INTERJ_RE = re.compile(r"(?<![A-Za-z'\-])(" + "|".join(p for p, _ in INTERJECTIONS) + r")(?![A-Za-z'])",
                        re.IGNORECASE)


def _interj(mo):
    w = mo.group(0)
    for pat, new in INTERJECTIONS:
        if re.fullmatch(pat, w, re.IGNORECASE):
            return _cap(w, new)
    return w


def respell_interjections(text):
    return _INTERJ_RE.sub(_interj, text) if text else text


_user = {"mtime": None, "map": {}, "path": None}


def set_user_file(path):
    _user["path"] = path


def _user_map():
    p = _user["path"]
    if not p or not os.path.exists(p):
        return {}
    try:
        m = os.path.getmtime(p)
        if m != _user["mtime"]:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            _user["map"] = {str(k).lower(): str(v) for k, v in data.items() if k and v}
            _user["mtime"] = m
    except (OSError, ValueError):
        pass
    return _user["map"]


def user_version():
    m = _user_map()
    return str(len(m)) + ":" + str(_user["mtime"] or 0)


def fix(text, cmu=False):
    if not text:
        return text
    out = []
    in_quote = False
    for part in re.split(r'(["“”])', text):
        if part in ('"', "“", "”"):
            in_quote = (part == "“") or (part == '"' and not in_quote)
            if part == "”":
                in_quote = False
            out.append(part)
            continue
        sentences = re.split(r"(?<=[.!?])(\s+)", part)
        out.append("".join(s if s.isspace() else _fix_sentence(s, in_quote, cmu) for s in sentences))
    text = "".join(out)
    if not cmu:
        text = respell_interjections(text)
    m = _user_map()
    if m:
        pat = re.compile(r"\b(" + "|".join(re.escape(k) for k in sorted(m, key=len, reverse=True)) + r")\b",
                         re.IGNORECASE)
        text = pat.sub(lambda mo: m.get(mo.group(0).lower(), mo.group(0)), text)
    return text
