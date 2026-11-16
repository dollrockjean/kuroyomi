# Windows version of start.sh: stop anything on the port, then run the server.
Set-Location $PSScriptRoot
$port = if ($env:PORT) { $env:PORT } else { 8000 }
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
$py = if (Test-Path .venv\Scripts\python.exe) { '.venv\Scripts\python.exe' } else { 'python' }
Write-Host "BYOB - Bring Your Own Books: http://localhost:$port"
& $py server.py
