
#!/bin/sh
set -e

ollama serve &
OLLAMA_PID=$!

# Wait for the API to be ready
until ollama list >/dev/null 2>&1; do
  sleep 1
done

pull_if_missing() {
  if ! ollama list | grep -q "^$1"; then
    echo "[ollama-init] pulling $1..."
    ollama pull "$1"
  else
    echo "[ollama-init] $1 already present, skipping pull."
  fi
}

pull_if_missing "$OLLAMA_CHAT_MODEL"
pull_if_missing "$OLLAMA_EMBED_MODEL"
echo "[ollama-init] models ready."

wait "$OLLAMA_PID"
