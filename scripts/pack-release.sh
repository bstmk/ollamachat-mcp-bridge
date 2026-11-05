#!/bin/sh
# Build a source archive from the package manifest. Does not install or configure Tailscale.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/dist}"
STAGE="$(mktemp -d)"

export PACK_ROOT="$ROOT"
export PACK_STAGE="$STAGE"
export PACK_OUT="$OUT_DIR"

node <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.env.PACK_ROOT;
const stageRoot = process.env.PACK_STAGE;
const pkg = require(path.join(root, 'package.json'));
const name = `ollamachat-mcp-bridge-${pkg.version}`;
const destRoot = path.join(stageRoot, name);
const skip = new Set(['bridge-policy.json', 'mcp-config.json', '.env']);

if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
  console.error('package.json files must list the archive contents');
  process.exit(1);
}

function copyPath(rel) {
  if (rel.split(/[\\/]/).some((part) => skip.has(part) || part === 'node_modules')) {
    console.error(`refusing to pack ${rel}`);
    process.exit(1);
  }
  const src = path.join(root, rel);
  const dest = path.join(destRoot, rel);
  if (!fs.existsSync(src)) {
    console.error(`manifest path missing: ${rel}`);
    process.exit(1);
  }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyPath(path.join(rel, entry));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  if (stat.mode & 0o111) fs.chmodSync(dest, stat.mode);
}

for (const rel of ['package.json', 'package-lock.json', ...pkg.files]) copyPath(rel);

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

const files = walk(destRoot);
const tests = files.filter((file) => file.endsWith('.test.js'));
if (tests.length < 1) {
  console.error('refusing to pack an archive with no automated tests');
  process.exit(1);
}
for (const banned of ['bridge-policy.json', 'mcp-config.json', '.env']) {
  if (files.some((file) => path.basename(file) === banned)) {
    console.error(`refusing to pack ${banned}`);
    process.exit(1);
  }
}
fs.writeFileSync(path.join(stageRoot, 'archive-name.txt'), name);
NODE

NAME="$(cat "$STAGE/archive-name.txt")"
mkdir -p "$OUT_DIR"
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
