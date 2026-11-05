#!/usr/bin/env bash
# start.sh — convenience launcher for the MCP-to-HTTP bridge
# Usage: ./start.sh [--config path/to/mcp-config.json] [--port 3100]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "[start.sh] node_modules not found — running npm ci..."
  npm ci
fi

echo "[start.sh] Starting MCP-to-HTTP bridge on loopback. See docs/INSTALL.md."
exec node server.js "$@"
