#!/usr/bin/env bash
# Install (or reinstall) Smoke Monkey on the Mac from source.
#
#   - builds the api-gateway + web UI + Rust release binary
#   - assembles "Smoke Monkey.app" (same as bundle-app.sh)
#   - installs it to /Applications
#
# OmniRoute is NOT bundled here — the app self-installs it on first launch
# (pinned to omniroute@3.8.50) and shows "Initializing OmniRoute…" while doing so.
#
# Usage: scripts/install.sh   (run from apps/desktop)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"

APP_NAME="Smoke Monkey Desktop.app"
APP_PATH="/Applications/$APP_NAME"
BUNDLE="$DESKTOP_DIR/src-tauri/target/release/Smoke Monkey.app"

for cmd in node pnpm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[install] missing prerequisite: $cmd" >&2
    exit 1
  fi
done

if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  echo "[install] installing workspace dependencies (pnpm install)..."
  (cd "$PROJECT_ROOT" && pnpm install)
fi

echo "[install] shutting down stale Smoke Monkey / backend processes..."
osascript -e "tell application \"Smoke Monkey Desktop\" to quit" >/dev/null 2>&1 || true
for port in 8642 8643; do
  pids="$(lsof -ti tcp:$port 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[install]   killing stale process(es) on port $port: $pids"
    kill $pids >/dev/null 2>&1 || true
    sleep 1
  fi
done
# Also kill any leftover node gateway/rag/omniroute scaffolding tied to this repo.
pkill -f "api-gateway/dist/main.js" >/dev/null 2>&1 || true
pkill -f "smoke-monkey-rag" >/dev/null 2>&1 || true
sleep 1

echo "[install] rebuilding api-gateway + web UI (fresh out/ + dist/)..."
(cd "$PROJECT_ROOT/apps/api-gateway" && pnpm build)
(cd "$PROJECT_ROOT/apps/web" && BUILD_FOR_DESKTOP=1 pnpm build)

echo "[install] forcing tauri-build to re-embed the fresh web assets..."
touch "$DESKTOP_DIR/src-tauri/build.rs"

echo "[install] building app (Rust release binary)..."
cd "$DESKTOP_DIR"
if ! pnpm exec tauri build --no-bundle; then
  echo "[install] build failed - run from: apps/desktop" >&2
  exit 1
fi

echo "[install] assembling .app bundle..."
bash "$SCRIPT_DIR/bundle-app.sh"

echo "[install] installing to ${APP_PATH}..."
# Quit the running app first (if any) so the bundle isn't replaced mid-run.
osascript -e "tell application \"Smoke Monkey Desktop\" to quit" >/dev/null 2>&1 || true
rm -rf "$APP_PATH"
cp -R "$BUNDLE" "$APP_PATH"

echo "[install] done - ${APP_PATH}"
echo "[install] start it with: open \"$APP_PATH\""