"""V11: which identity fields the PC has locally (names only, no values)."""
import json
import os

for path in (r"C:/Users/dollr/BYoB Backups/keeper/keeper.json",
             r"C:/Users/dollr/BYoB Backups/kokoro/config.json"):
    print("---", path)
    if not os.path.exists(path):
        print("   missing")
        continue
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    for k, v in sorted(d.items()):
        if isinstance(v, str) and any(s in k.lower() for s in ("key", "token", "secret")):
            print(f"   {k}: <set, {len(v)} chars>")
        else:
            print(f"   {k}: {v!r}"[:120])
