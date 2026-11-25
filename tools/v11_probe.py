"""V11 probe: what the PC voice side looks like right now (no secrets printed)."""
import json
import os
import subprocess

CFG = r"C:/Users/dollr/BYoB Backups/kokoro/config.json"
print("--- config.json")
if os.path.exists(CFG):
    with open(CFG, encoding="utf-8") as fh:
        cfg = json.load(fh)
    for k, v in cfg.items():
        if k in ("token", "key", "secret"):
            print(f"   {k}: <set, {len(str(v))} chars>")
        else:
            print(f"   {k}: {v}")
else:
    print("   missing")

print("--- kokoro dir")
d = os.path.dirname(CFG)
if os.path.isdir(d):
    print("  ", os.listdir(d))

print("--- python processes")
out = subprocess.run(
    ["powershell", "-NoProfile", "-Command",
     "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | "
     "Select-Object ProcessId,CommandLine | Format-List"],
    capture_output=True, text=True)
print(out.stdout[:3000])

print("--- listening ports 8766 / cloudflared")
out = subprocess.run(
    ["powershell", "-NoProfile", "-Command",
     "Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in 8766,8765} | "
     "Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table; "
     "Get-Process cloudflared,kokoro* -ErrorAction SilentlyContinue | Select-Object Id,Name | Format-Table"],
    capture_output=True, text=True)
print(out.stdout[:2000])
