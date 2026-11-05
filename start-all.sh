#!/bin/bash
# Start Ollama + MCP bridge together

echo "Starting Ollama on loopback only..."
echo "This script does not configure Tailscale and does not install a login item."
OLLAMA_HOST=127.0.0.1 ollama serve &
OLLAMA_PID=$!

echo "Ollama PID: $OLLAMA_PID"

echo "Starting MCP bridge..."
cd "$(dirname "$0")"
./start.sh &
BRIDGE_PID=$!

echo "Bridge PID: $BRIDGE_PID"
echo "Both running. Kill with: kill $OLLAMA_PID $BRIDGE_PID"

wait
