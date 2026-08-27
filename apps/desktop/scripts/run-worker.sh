#!/usr/bin/env bash
# Start the local document-worker (local storage mode) for the desktop app.
# It polls the shared jobs.db and indexes uploaded PDFs into the same local
# stores rag-service reads. Used in development only — packaged builds ship a
# PyInstaller sidecar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKER_DIR="$ROOT/apps/document-worker"
VENV_PY="$WORKER_DIR/.venv/bin/python"

if [ -n "${RAG_WORKER:-}" ]; then
  exec "$RAG_WORKER"
fi

if [ ! -x "$VENV_PY" ]; then
  echo "document-worker venv not found at $VENV_PY — create it first (see docs/ARCHITECTURE_CURRENT.md)" >&2
  exit 1
fi

export STORAGE_MODE=local
export LOCAL_DATA_DIR="${LOCAL_DATA_DIR:-$ROOT/data/desktop}"
export PYTHONPATH="${PYTHONPATH:-}:$WORKER_DIR"
mkdir -p "$LOCAL_DATA_DIR"
exec "$VENV_PY" -m src.main --log-level info
