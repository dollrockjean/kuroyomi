"""Append V11 verify lines to the Duet progress note (one line per step)."""
import sys

NOTE = (r"C:/Users/dollr/Documents/Claude/Claude Notes/From Duet/"
        r"BYoB Kokoro Progress 2026-11-22.md")

lines = [a for a in sys.argv[1:] if a.strip()]
if not lines:
    raise SystemExit("nothing to log")
with open(NOTE, "a", encoding="utf-8") as fh:
    for line in lines:
        fh.write("- " + line.rstrip() + "\n")
print("logged", len(lines), "line(s)")
