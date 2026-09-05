#!/usr/bin/env bash
cd "$(dirname "$0")"
PORT="${PORT:-8000}"

# Clean up any lingering old server process holding the port
OLD_PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "Stopping previous server instance (PID $OLD_PID)..."
  kill -9 $OLD_PID 2>/dev/null || true
  sleep 0.5
fi

echo "=========================================================="
echo "  KUROYOMI · CLOUD-SYNCED WEB NOVEL READER"
echo "=========================================================="
echo "Starting server on port $PORT..."
echo "Access locally: http://localhost:$PORT"
echo "Access on iOS / LAN: http://$(ipconfig getifaddr en0 2>/dev/null || echo 'localhost'):$PORT"
echo "=========================================================="
PYTHON_CMD="python3"
if [ -x "/Library/Developer/CommandLineTools/usr/bin/python3" ]; then
  PYTHON_CMD="/Library/Developer/CommandLineTools/usr/bin/python3"
fi

exec "$PYTHON_CMD" server.py
