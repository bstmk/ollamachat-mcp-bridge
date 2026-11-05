#!/bin/sh
# Build a source archive for the Mac. Does not install, start, or configure Tailscale.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="ollamachat-mcp-bridge-$VERSION"
OUT_DIR="${1:-$ROOT/dist}"
STAGE="$(mktemp -d)"

mkdir -p "$OUT_DIR" "$STAGE/$NAME"

copy() {
  mkdir -p "$STAGE/$NAME/$(dirname "$1")"
  cp "$ROOT/$1" "$STAGE/$NAME/$1"
}

copy package.json
copy package-lock.json
copy server.js
copy security-policy.js
copy mcp-manager.js
copy mcp-process.js
copy sse-handler.js
copy streamable-handler.js
copy ollama-tool-chat.js
copy bridge-policy.example.json
copy custom-tools.json
copy mcp-config.example.json
copy README.md
copy start.sh
copy start-all.sh
copy calendar-events.sh
copy verse-of-the-day.sh
copy docs/INSTALL.md
copy docs/THREAT-MODEL.md
copy docs/PEEKABOO-ALLOWLIST.md

# The live policy and any local MCP map are personal and stay out of the archive.
if [ -f "$STAGE/$NAME/bridge-policy.json" ] || [ -f "$STAGE/$NAME/mcp-config.json" ] || [ -f "$STAGE/$NAME/.env" ]; then
  echo "refusing to pack local policy or secrets" >&2
  exit 1
fi

# Shell helpers ship as inert files. The bridge does not execute them.
find "$STAGE/$NAME" -type f -print | sort > "$STAGE/files.txt"

tar -C "$STAGE" -czf "$OUT_DIR/$NAME.tar.gz" "$NAME"
if command -v sha256sum >/dev/null 2>&1; then
  SUM="$(sha256sum "$OUT_DIR/$NAME.tar.gz" | awk '{print $1}')"
else
  SUM="$(shasum -a 256 "$OUT_DIR/$NAME.tar.gz" | awk '{print $1}')"
fi
printf '%s  %s\n' "$SUM" "$NAME.tar.gz" > "$OUT_DIR/$NAME.tar.gz.sha256"
rm -rf "$STAGE"
echo "$OUT_DIR/$NAME.tar.gz"
echo "$SUM"
