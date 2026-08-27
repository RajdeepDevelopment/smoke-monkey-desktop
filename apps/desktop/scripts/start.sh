#!/bin/bash
# Start the API server and wait for it to be ready before launching Tauri

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
API_DIR="$PROJECT_ROOT/apps/api-gateway"

# Kill any existing API on port 3000
lsof -ti:3000 | xargs kill 2>/dev/null
sleep 1

# Start API in background
cd "$API_DIR"
DB_DRIVER=sqlite PORT=3000 node dist/main.js &
API_PID=$!

echo "[smoke-monkey] API starting (PID=$API_PID)..."

# Wait for API to be ready
for i in $(seq 1 30); do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null | grep -q "200\|207"; then
        echo "[smoke-monkey] API ready"
        break
    fi
    sleep 0.5
done

# Launch Tauri
cd "$SCRIPT_DIR/.."
pnpm tauri dev

# Kill API when Tauri exits
kill $API_PID 2>/dev/null
