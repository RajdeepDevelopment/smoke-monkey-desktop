#!/usr/bin/env bash
# Start the local rag-service backend (local storage mode) for the desktop app.
# Used in development only — packaged builds ship a PyInstaller sidecar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RAG_DIR="$ROOT/apps/rag-service"
VENV_PY="$RAG_DIR/.venv/bin/python"

# Uncommon port so the desktop backend never collides with the cloud gateway /
# web stack (docker or local, typically :8000).
PORT="${RAG_SERVICE_PORT:-8642}"
if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "rag-service already running on port ${PORT}" >&2
  exit 0
fi

if [ -n "${RAG_BACKEND:-}" ]; then
  exec "$RAG_BACKEND"
fi

if [ ! -x "$VENV_PY" ]; then
  echo "rag-service venv not found at $VENV_PY — create it first (see docs/ARCHITECTURE_CURRENT.md)" >&2
  exit 1
fi

export STORAGE_MODE=local
export LOCAL_DATA_DIR="${LOCAL_DATA_DIR:-$ROOT/data/desktop}"
# Desktop ships with free mode and web search on. The "free" gateway is the
# rag-service itself (served at /v1 on this same port), so no separate OmniRoute
# install is needed — it proxies to free models using the user's saved BYOK key.
export OMNIROUTE_ENABLED=true
export OMNIROUTE_BASE_URL="http://127.0.0.1:${PORT}/v1"
export OMNIROUTE_CHAT_MODELS='["auto", "big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free", "nemotron-3-ultra-free", "laguna-s-2.1-free", "nvidia/nemotron-3-nano-30b-a3b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b", "deepseek/deepseek-v4-flash:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemini-2.0-flash-lite:free", "meta-llama/llama-4-scout-17b-16e:free", "mistralai/mistral-small-3.2:free"]'
export WEB_SEARCH_ENABLED=true
mkdir -p "$LOCAL_DATA_DIR"
exec "$VENV_PY" -m uvicorn src.main:app --app-dir "$RAG_DIR" --host 127.0.0.1 --port "$PORT" --log-level info
