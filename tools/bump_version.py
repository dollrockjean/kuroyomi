"""Bump the app version in the one place per file that carries it.

The asset query strings matter as much as /health: without them a phone keeps the
service worker's cached CSS and JS and never sees the change.

  python tools/bump_version.py 55 56
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = [
    "server.py",
    "public/sw.js",
    "public/index.html",
    "tests/test_ui_improvements.py",
]


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    old, new = sys.argv[1], sys.argv[2]
    swaps = [
        ('APP_VERSION = "v%s"' % old, 'APP_VERSION = "v%s"' % new),
        ("Service Worker v%s" % old, "Service Worker v%s" % new),
        ("byob-v%s" % old, "byob-v%s" % new),
        ("v=%s.0" % old, "v=%s.0" % new),
    ]
    total = 0
    for rel in FILES:
        path = os.path.join(REPO, rel)
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        before = text
        for a, b in swaps:
            text = text.replace(a, b)
        if text != before:
            hits = sum(before.count(a) for a, _ in swaps)
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
            print("%-32s %d replacement(s)" % (rel, hits))
            total += hits
        else:
            print("%-32s unchanged" % rel)
    print("total:", total)
    return 0 if total else 1


if __name__ == "__main__":
    sys.exit(main())
