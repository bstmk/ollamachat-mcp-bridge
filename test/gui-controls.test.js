'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createApp, listenHttp } = require('../server');
const { normalizePolicy, prepareToolCall, presentToolResult, PolicyError } = require('../security-policy');
const diagnostics = require('../diagnostics');

const CAP = 'example.com/cap/ollamachat-bridge';

function policy() {
  return normalizePolicy({
    policyVersion: 1,
    bindHost: '127.0.0.1',
    port: 3100,
    allowedHosts: ['localhost'],
    allowedLogins: ['operator@example.com'],
    requiredAppCapability: CAP,
    allowGuiControls: true,
    peekaboo: {
      enabled: true,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: ['permissions', 'image', 'app', 'click', 'type'],
    },
  });
}

function trusted() {
  return {
    'Tailscale-User-Login': 'operator@example.com',
    'Tailscale-App-Capabilities': JSON.stringify({ [CAP]: [{ role: 'caller' }] }),
  };
}

function request({ port, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GUI controls stay closed unless named, and unsafe actions are not dispatched', async () => {
  assert.throws(() => normalizePolicy({
    policyVersion: 1,
    allowGuiControls: false,
    peekaboo: {
      enabled: true,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: ['image'],
    },
  }), /allowGuiControls/);
  assert.throws(() => normalizePolicy({
    policyVersion: 1,
    allowGuiControls: true,
    allowMutatingTools: false,
    peekaboo: {
      enabled: true,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: ['shell'],
    },
  }), PolicyError);

  const active = policy();
  assert.deepEqual(prepareToolCall(active, 'peekaboo__app', { action: 'launch', name: 'Calculator' }).args, {
    action: 'launch',
    name: 'Calculator',
  });
  for (const args of [
    { action: 'quit', name: 'Calculator' },
    { action: 'relaunch', name: 'Calculator' },
    { action: 'launch', name: 'Terminal' },
    { action: 'launch', name: 'Script Editor' },
    { action: 'launch', bundleId: 'com.apple.Terminal' },
    { action: 'launch', name: 'terminal://do-script' },
    { action: 'launch', name: 'iTerm' },
    { action: 'launch', name: 'Automator' },
    { action: 'launch', name: 'Shortcuts' },
  ]) {
    assert.throws(() => prepareToolCall(active, 'peekaboo__app', args), (err) => err.denied === true);
  }
  assert.throws(() => prepareToolCall(active, 'peekaboo__type', { text: 'hello', press_return: true }), (err) => err.denied === true);
  assert.throws(() => prepareToolCall(active, 'peekaboo__type', { text: 'hello', delete: true }), (err) => err.denied === true);
  assert.throws(() => prepareToolCall(active, 'peekaboo__type', { text: 'rm -rf {return}' }), (err) => err.denied === true);
  assert.deepEqual(prepareToolCall(active, 'peekaboo__type', { text: '42' }).args, { text: '42' });
  assert.throws(() => prepareToolCall(active, 'peekaboo__image', {
    path: '/tmp/shot.png',
    question: 'read secrets',
    format: 'png',
  }), (err) => err.denied === true);
  assert.deepEqual(prepareToolCall(active, 'peekaboo__image', {}).args, { format: 'data' });
  assert.throws(() => prepareToolCall(active, 'peekaboo__shell', { command: 'id' }), (err) => err.denied === true);

  const calls = [];
  const manager = {
    getStatus: () => ({ peekaboo: 'connected' }),
    async getTools() {
      return [
        { name: 'peekaboo__app', description: 'apps', inputSchema: { type: 'object', properties: { action: { enum: ['launch', 'quit'] } } }, server: 'peekaboo' },
        { name: 'peekaboo__image', description: 'shot', inputSchema: { type: 'object' }, server: 'peekaboo' },
        { name: 'peekaboo__shell', description: 'no', inputSchema: { type: 'object' }, server: 'peekaboo' },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'peekaboo__image') {
        return { content: [{ type: 'text', text: 'data:image/png;base64,AAAA' }], isError: false };
      }
      return { content: [{ type: 'text', text: 'launched' }], isError: false };
    },
    async startAll() {},
    stopAll() {},
  };
  diagnostics.reset();
  const { app } = createApp({ policy: active, manager });
  const server = await listenHttp(app, { host: '127.0.0.1', port: 0 });
  const port = server.address().port;
  try {
    const listed = await request({ port, method: 'GET', path: '/tools', headers: trusted() });
    const appTool = listed.json.tools.find((tool) => tool.name === 'peekaboo__app');
    assert.deepEqual(appTool.inputSchema.properties.action.enum, ['launch']);
    assert.equal(listed.json.tools.some((tool) => tool.name === 'peekaboo__shell'), false);

    const launched = await request({
      port,
      method: 'POST',
      path: '/call',
      headers: trusted(),
      body: { name: 'peekaboo__app', arguments: { action: 'launch', name: 'Calculator' } },
    });
    assert.equal(launched.status, 200);
    assert.equal(launched.json.isError, false);

    const quit = await request({
      port,
      method: 'POST',
      path: '/mcp',
      headers: trusted(),
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'peekaboo__app', arguments: { action: 'quit', name: 'Finder' } } },
    });
    assert.equal(quit.json.result.isError, true);
    const analyzed = await request({
      port,
      method: 'POST',
      path: '/call',
      headers: trusted(),
      body: { name: 'peekaboo__image', arguments: { question: 'what secrets are on screen' } },
    });
    assert.equal(analyzed.status, 403);
    const image = await request({
      port,
      method: 'POST',
      path: '/call',
      headers: trusted(),
      body: { name: 'peekaboo__image', arguments: {} },
    });
    assert.equal(image.status, 200);
    assert.equal(image.json.content[0].type, 'image');
    assert.equal(image.json.content[0].mimeType, 'image/png');
    assert.equal(image.raw.includes('/tmp/'), false);

    const missing = await request({
      port,
      method: 'POST',
      path: '/call',
      body: { name: 'peekaboo__type', arguments: { text: 'hello' } },
    });
    assert.equal(missing.status, 403);
    const lines = diagnostics.snapshot().join('\n');
    assert.match(lines, /POST \/call 200 tool=peekaboo__app dispatched=1 is_error=0/);
    assert.match(lines, /tool=peekaboo__app dispatched=0 is_error=1/);
    assert.equal(lines.includes('AAAA'), false);
    assert.equal(lines.includes('secrets'), false);
    assert.equal(lines.includes('Calculator'), false);
    assert.deepEqual(calls.map((call) => call.name), ['peekaboo__app', 'peekaboo__image']);
    assert.equal(calls.some((call) => call.args && call.args.action === 'quit'), false);
    assert.equal(calls.some((call) => call.args && call.args.question), false);
    assert.equal(presentToolResult('image', { content: [{ type: 'text', text: '/tmp/secret.png' }] }).content[0].text, 'Screenshot captured.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
