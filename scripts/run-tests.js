'use strict';

/**
 * Run the shipped node:test files and refuse a zero-test success.
 * `node --test` exits 0 when it finds no files. That hid the 2.0.0 archive,
 * which omitted test/ and reported 0 tests after npm ci --omit=dev.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');
let files = [];
try {
  files = fs.readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(testDir, name));
} catch (_) {
  files = [];
}
if (files.length < 1) {
  console.error('recorded-test-count: 0');
  console.error('refusing a zero-test pass');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', ...files],
  { cwd: root, encoding: 'utf8' }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

const match = (result.stdout || '').match(/^# tests (\d+)/m);
const count = match ? Number(match[1]) : 0;
console.error(`recorded-test-count: ${count}`);
if (!match || count < 1) {
  console.error('refusing a zero-test pass');
  process.exit(1);
}
process.exit(result.status === 0 ? 0 : result.status || 1);
