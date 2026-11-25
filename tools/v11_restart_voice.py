"""V11: leave exactly one Kokoro supervisor running.

Stops every kokoro supervisor / voice server and only the cloudflared started for BYoB (it is the
one using the quick-tunnel.yml in the BYoB data folder; the other cloudflared on this PC belongs to
the Hive bridge and is left alone), then starts one supervisor, which now holds a single-instance
lock.
"""
import os
import subprocess
import sys
import time

PY = r"C:\Users\dollr\claude-work\byob\kokoroenv\Scripts\pythonw.exe"
SUP = r"C:\Users\dollr\Claude Projects\novel-reader\tools\kokoro_supervisor.py"


def ps(cmd):
    return subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                          capture_output=True, text=True).stdout


def procs():
    out = ps("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -ne $null } | "
             "ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }")
    rows = []
    for line in out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), parts[1], parts[2]))
    return rows


def mine(rows):
    out = []
    for pid, name, cmd in rows:
        low = cmd.lower()
        if "kokoro_supervisor.py" in low or "kokoro_server.py" in low:
            out.append((pid, name, cmd))
        elif name.lower().startswith("cloudflared") and "quick-tunnel.yml" in low:
            out.append((pid, name, cmd))
    return out


print("--- running now")
targets = mine(procs())
for pid, name, cmd in targets:
    print(f"   {pid:>8} {name} {cmd[:110]}")

if "--list" in sys.argv:
    sys.exit(0)

print("--- stopping them")
for pid, name, _ in targets:
    r = subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, text=True)
    print(f"   {pid} {name}: {(r.stdout or r.stderr).strip()[:90]}")

time.sleep(3)
left = mine(procs())
print("   left over:", [(p, n) for p, n, _ in left])

print("--- starting one supervisor")
exe = PY if os.path.exists(PY) else sys.executable
proc = subprocess.Popen([exe, SUP], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
print("   started pid", proc.pid, "with", exe)
time.sleep(25)
print("--- running after the restart")
for pid, name, cmd in mine(procs()):
    print(f"   {pid:>8} {name} {cmd[:110]}")
