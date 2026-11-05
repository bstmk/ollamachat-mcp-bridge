'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { McpManager, setBraveKey, setOsaurusKey } = require('../mcp-manager');
const { createApp, listenHttp } = require('../server');
const {
  PolicyError,
  assertLoopbackHost,
  checkIdentity,
  defaultPolicy,
  normalizePolicy,
  peekabooSpawnPlan,
  toolAllowed,
} = require('../security-policy');

const CAP = 'example.com/cap/ollamachat-bridge';

function policy(overrides = {}) {
  const { peekaboo: peekOverrides, ...rest } = overrides;
  return normalizePolicy({
    policyVersion: 1,
    bindHost: '127.0.0.1',
    port: 3100,
    allowedHosts: ['localhost', 'mac-studio.example.ts.net'],
    allowedOrigins: [],
    allowedLogins: ['operator@example.com'],
    requiredAppCapability: CAP,
    identityMode: 'user',
    allowSensitiveObservation: false,
    allowMutatingTools: false,
    ...rest,
    peekaboo: {
      enabled: true,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: ['permissions'],
      ...peekOverrides,
    },
  });
}

function capabilityHeader(cap = CAP, value = [{ role: 'caller' }]) {
  return JSON.stringify({ [cap]: value });
}

function trustedHeaders(extra = {}) {
  return {
    'Tailscale-User-Login': 'operator@example.com',
    'Tailscale-App-Capabilities': capabilityHeader(),
    ...extra,
  };
}

function mockManager() {
  const calls = [];
  return {
    calls,
    getStatus: () => ({ peekaboo: 'connected' }),
    async getTools() {
      return [
        { name: 'peekaboo__permissions', description: 'Report permission state', inputSchema: { type: 'object', properties: {} }, server: 'peekaboo' },
        { name: 'peekaboo__see', description: 'Capture UI', inputSchema: { type: 'object', properties: {} }, server: 'peekaboo' },
        { name: 'peekaboo__click', description: 'Click', inputSchema: { type: 'object', properties: {} }, server: 'peekaboo' },
        { name: 'custom__music_play', description: 'shell', inputSchema: { type: 'object', properties: {} }, server: 'custom' },
        { name: 'builtin__list_directory', description: 'shell', inputSchema: { type: 'object', properties: {} }, server: 'builtin' },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `ran:${name}` }], isError: false };
    },
    async startAll() {},
    stopAll() {},
  };
}

function assertNoCors(response) {
  for (const name of [
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-allow-methods',
    'access-control-allow-headers',
  ]) {
    assert.equal(response.headers[name], undefined, `${name} must not be set`);
  }
  assert.equal(String(response.raw).includes('Access-Control-Allow-Origin'), false);
}

function request({ port, method, path: reqPath, headers, body, host }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: {
        Host: host || `127.0.0.1:${port}`,
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(policyObject, fn) {
  const inner = mockManager();
  const { app } = createApp({ policy: policyObject, manager: inner });
  const server = await listenHttp(app, { host: '127.0.0.1', port: 0 });
  try {
    await fn(server.address().port, inner);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const PROTOCOL_PATHS = [
  ['GET', '/health'],
  ['GET', '/tools'],
  ['GET', '/tools/openai'],
  ['POST', '/call'],
  ['GET', '/sse'],
  ['POST', '/messages'],
  ['POST', '/mcp'],
  ['GET', '/mcp'],
  ['DELETE', '/mcp'],
];

const MUTATION_PATHS = [
  ['GET', '/config'],
  ['POST', '/config'],
  ['PUT', '/config'],
  ['PATCH', '/config'],
  ['DELETE', '/config'],
  ['GET', '/custom-tools'],
  ['POST', '/custom-tools'],
  ['PUT', '/custom-tools'],
  ['PATCH', '/custom-tools'],
  ['DELETE', '/custom-tools/music_play'],
];

test('runtime package ships tests and has no test-only npm dependency', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.js');
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.files.includes('test'), true);
  assert.equal(pkg.files.includes('scripts/run-tests.js'), true);
  assert.equal(fs.existsSync(path.join(__dirname, 'bridge.test.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'scripts', 'run-tests.js')), true);
});

test('default bind is loopback and non-loopback hosts are refused', () => {
  assert.equal(assertLoopbackHost(undefined), '127.0.0.1');
  assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.equal(assertLoopbackHost('::1'), '::1');
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'localhost']) {
    assert.throws(() => assertLoopbackHost(host), PolicyError);
  }
  assert.throws(() => normalizePolicy({
    policyVersion: 1,
    bindHost: '0.0.0.0',
    peekaboo: {
      enabled: false,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: [],
    },
  }), /loopback|Refusing bind/i);
});

test('listens on 127.0.0.1 and does not open 0.0.0.0', async () => {
  const { app } = createApp({ policy: policy(), manager: mockManager() });
  const server = await listenHttp(app, { host: '127.0.0.1', port: 0 });
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const { app: app2 } = createApp({ policy: policy(), manager: mockManager() });
  assert.throws(() => listenHttp(app2, { host: '0.0.0.0', port: 0 }), PolicyError);
});

test('policy fails closed on wildcard login, shell command, extra args, unknown and mutating tools', () => {
  assert.throws(() => policy({ allowedLogins: ['*'] }), PolicyError);
  assert.throws(() => policy({ allowedLogins: ['operator@example.com', 'someone-else'] }), PolicyError);
  assert.throws(() => policy({ peekaboo: { command: 'bash' } }), /peekaboo/);
  assert.throws(() => policy({ peekaboo: { command: '/tmp/bash' } }), /basename/);
  assert.throws(() => policy({ peekaboo: { command: '/opt/homebrew/bin/peekaboo/../../bin/bash' } }), /exact/);
  assert.throws(() => policy({ peekaboo: { args: ['mcp', '--extra'] } }), /args/);
  assert.throws(() => policy({ peekaboo: { tools: ['click'] } }), /allowGuiControls/);
  assert.throws(() => policy({ peekaboo: { tools: ['see'] } }), /sensitive/);
  assert.throws(() => policy({ peekaboo: { tools: ['shell'] } }), /mutating|unreviewed/);
  assert.throws(() => policy({ peekaboo: { tools: ['not_a_real_tool'] } }), /unreviewed/);
  assert.throws(() => policy({ surprise: true }), /Unknown policy field/);
  assert.throws(() => normalizePolicy({
    reminders: { command: 'npx', args: ['reminders-mcp'] },
  }), /policyVersion/);

  const opted = policy({
    allowMutatingTools: true,
    allowSensitiveObservation: true,
    allowGuiControls: true,
    peekaboo: { tools: ['permissions', 'see', 'click'] },
  });
  assert.equal(toolAllowed(opted, 'peekaboo__click'), true);
  assert.equal(toolAllowed(opted, 'custom__click'), false);
  assert.equal(toolAllowed(opted, 'peekaboo__not_a_real_tool'), false);
});

test('spawn plan is empty unless Peekaboo is enabled with an allowlist, and the child filter is explicit', () => {
  const disabled = defaultPolicy();
  assert.equal(disabled.peekaboo.enabled, false);
  assert.equal(disabled.allowedLogins.length, 0);
  assert.equal(peekabooSpawnPlan(disabled), null);
  assert.equal(peekabooSpawnPlan(policy({ peekaboo: { enabled: false, tools: ['permissions'] } })), null);
  assert.equal(peekabooSpawnPlan(policy({ peekaboo: { tools: [] } })), null);

  const plan = peekabooSpawnPlan(policy());
  assert.equal(plan.command, '/opt/homebrew/bin/peekaboo');
  assert.deepEqual(plan.args, ['mcp']);
  assert.equal(plan.env.PEEKABOO_ALLOW_TOOLS, 'permissions');
  assert.match(plan.env.PEEKABOO_DISABLE_TOOLS, /\bclick\b/);
  assert.match(plan.env.PEEKABOO_DISABLE_TOOLS, /\bsee\b/);
  assert.match(plan.env.PEEKABOO_DISABLE_TOOLS, /\btype\b/);
  assert.equal(plan.env.PEEKABOO_DISABLE_TOOLS.includes('permissions'), false);
  assert.deepEqual(plan.stripEnv, ['BRAVE_SEARCH_API_KEY', 'OSAURUS_ACCESS_KEY', 'BRAVE_API_KEY']);
});

test('identity fails closed for missing, wrong, funnel, and capability-less callers', () => {
  const active = policy();
  const headers = (extra) => ({
    'tailscale-user-login': 'operator@example.com',
    'tailscale-app-capabilities': capabilityHeader(),
    ...extra,
  });

  assert.equal(checkIdentity(active, headers()).ok, true);
  assert.equal(checkIdentity(active, {}).reason, 'forbidden_identity');
  assert.equal(checkIdentity(active, headers({
    'tailscale-user-login': 'other@example.com',
  })).reason, 'forbidden_identity');
  assert.equal(checkIdentity(active, {
    'tailscale-app-capabilities': capabilityHeader(),
  }).reason, 'forbidden_identity');
  assert.equal(checkIdentity(active, headers({
    'tailscale-app-capabilities': capabilityHeader('example.com/cap/other'),
  })).reason, 'forbidden_identity');
  assert.equal(checkIdentity(active, headers({
    'tailscale-app-capabilities': '{}',
  })).reason, 'forbidden_identity');
  assert.equal(checkIdentity(active, headers({
    'tailscale-app-capabilities': JSON.stringify({ [CAP]: 'caller' }),
  })).reason, 'forbidden_identity');
  assert.equal(checkIdentity(active, headers({
    'tailscale-funnel-request': '?1',
  })).reason, 'forbidden_funnel');
  assert.equal(checkIdentity(defaultPolicy(), headers()).reason, 'forbidden_identity');
  assert.equal(checkIdentity(active, headers({
    'tailscale-user-login': '=?utf-8?q?operator=40example.com?=',
  })).ok, true);

  const tagged = policy({ identityMode: 'tagged', allowedLogins: [] });
  assert.equal(checkIdentity(tagged, {
    'tailscale-app-capabilities': capabilityHeader(),
  }).ok, true);
  assert.equal(checkIdentity(tagged, headers()).reason, 'forbidden_identity');
  assert.throws(() => policy({ identityMode: 'tagged', allowedLogins: ['operator@example.com'] }), /tagged/);
});

test('invalid host and origin are rejected on every audited path, with no CORS headers', async () => {
  const paths = [...PROTOCOL_PATHS, ...MUTATION_PATHS, ['POST', '/anything'], ['OPTIONS', '/call']];
  await withServer(policy(), async (port) => {
    for (const [method, reqPath] of paths) {
      const badHost = await request({
        port,
        method,
        path: reqPath,
        host: 'evil.example',
        headers: trustedHeaders(),
        body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? { name: 'peekaboo__permissions' } : undefined,
      });
      assert.equal(badHost.status, 403, `${method} ${reqPath} host`);
      assert.equal(badHost.json.reason, 'forbidden_host');
      assertNoCors(badHost);

      const badOrigin = await request({
        port,
        method,
        path: reqPath,
        headers: trustedHeaders({ Origin: 'https://evil.example' }),
        body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? { name: 'peekaboo__permissions' } : undefined,
      });
      assert.equal(badOrigin.status, 403, `${method} ${reqPath} origin`);
      assert.equal(badOrigin.json.reason, 'forbidden_origin');
      assertNoCors(badOrigin);

      const nullOrigin = await request({
        port,
        method,
        path: reqPath,
        headers: trustedHeaders({ Origin: 'null' }),
      });
      assert.equal(nullOrigin.status, 403);
      assert.equal(nullOrigin.json.reason, 'forbidden_origin');
      assertNoCors(nullOrigin);
    }
  });
});

test('missing identity is denied on protocol and mutation paths', async () => {
  await withServer(policy(), async (port) => {
    for (const [method, reqPath] of [...PROTOCOL_PATHS, ...MUTATION_PATHS]) {
      const response = await request({
        port,
        method,
        path: reqPath,
        body: method === 'GET' || method === 'DELETE' ? undefined : {
          name: 'peekaboo__click',
          braveSearchApiKey: 'should-not-stick',
          command: 'bash',
        },
      });
      assert.equal(response.status, 403, `${method} ${reqPath}`);
      assert.equal(response.json.reason, 'forbidden_identity');
      assertNoCors(response);
      assert.equal(response.raw.includes('should-not-stick'), false);
    }
  });
});

test('trusted callers can read the allowlisted tool and cannot mutate config or dispatch other tools', async () => {
  await withServer(policy(), async (port, inner) => {
    const health = await request({ port, method: 'GET', path: '/health', headers: trustedHeaders() });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assertNoCors(health);

    const tailnetHost = await request({
      port,
      method: 'GET',
      path: '/health',
      host: 'mac-studio.example.ts.net:38443',
      headers: trustedHeaders(),
    });
    assert.equal(tailnetHost.status, 200);

    const tools = await request({ port, method: 'GET', path: '/tools', headers: trustedHeaders() });
    assert.deepEqual(tools.json.tools.map((tool) => tool.name), ['peekaboo__permissions']);
    assertNoCors(tools);

    const openai = await request({ port, method: 'GET', path: '/tools/openai', headers: trustedHeaders() });
    assert.deepEqual(openai.json.map((tool) => tool.function.name), ['peekaboo__permissions']);

    const allowed = await request({
      port,
      method: 'POST',
      path: '/call',
      headers: trustedHeaders(),
      body: { name: 'peekaboo__permissions', arguments: {} },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.content[0].text, 'ran:peekaboo__permissions');
    assert.deepEqual(inner.calls.map((call) => call.name), ['peekaboo__permissions']);

    for (const name of ['peekaboo__click', 'peekaboo__see', 'custom__music_play', 'builtin__list_directory', 'bash']) {
      const denied = await request({
        port,
        method: 'POST',
        path: '/call',
        headers: trustedHeaders(),
        body: { name, arguments: { command: 'touch /tmp/not-allowed' } },
      });
      assert.equal(denied.status, 403, name);
      assert.equal(denied.json.error, 'Tool denied');
      assert.equal(denied.raw.includes('ran:'), false);
      assertNoCors(denied);
    }
    assert.deepEqual(inner.calls.map((call) => call.name), ['peekaboo__permissions']);

    for (const [method, reqPath] of MUTATION_PATHS) {
      const response = await request({
        port,
        method,
        path: reqPath,
        headers: trustedHeaders(),
        body: method === 'GET' || method === 'DELETE' ? undefined : {
          name: 'pwn',
          command: 'osascript -e beep',
          braveSearchApiKey: 'sekret-value',
          osaurusAccessKey: 'osk-v1.sekret',
        },
      });
      assert.equal(response.status, 403, `${method} ${reqPath}`);
      assert.equal(response.json.reason, 'forbidden_configuration');
      assert.equal(response.raw.includes('sekret'), false);
      assertNoCors(response);
    }
    assert.deepEqual(inner.calls.map((call) => call.name), ['peekaboo__permissions']);
  });
});

test('streamable HTTP and SSE refuse mutation and do not dispatch denied tools', async () => {
  await withServer(policy(), async (port, inner) => {
    const init = await request({
      port,
      method: 'POST',
      path: '/mcp',
      headers: trustedHeaders(),
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, '2025-03-26');
    assertNoCors(init);

    const listed = await request({
      port,
      method: 'POST',
      path: '/mcp',
      headers: trustedHeaders(),
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name), ['peekaboo__permissions']);

    const denied = await request({
      port,
      method: 'POST',
      path: '/mcp',
      headers: trustedHeaders(),
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'peekaboo__click', arguments: { on: 'B1' } },
      },
    });
    assert.equal(denied.json.result.isError, true);
    assert.equal(denied.raw.includes('ran:'), false);

    const batch = await request({
      port,
      method: 'POST',
      path: '/mcp',
      headers: trustedHeaders(),
      body: [
        { jsonrpc: '2.0', id: 4, method: 'config/set', params: { braveSearchApiKey: 'sekret-value' } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'custom__music_play', arguments: { name: '$(id)' } } },
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'peekaboo__permissions', arguments: {} } },
      ],
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.raw.includes('sekret'), false);
    assert.equal(batch.raw.includes('ran:custom__'), false);
    assert.equal(batch.raw.includes('ran:peekaboo__permissions'), true);
    assert.deepEqual(inner.calls.map((call) => call.name), ['peekaboo__permissions']);

    const missing = await request({
      port,
      method: 'POST',
      path: '/mcp',
      body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'peekaboo__permissions', arguments: {} } },
    });
    assert.equal(missing.status, 403);
    assert.equal(missing.json.reason, 'forbidden_identity');

    const sseReq = http.get({
      host: '127.0.0.1',
      port,
      path: '/sse',
      headers: {
        Host: `127.0.0.1:${port}`,
        ...trustedHeaders(),
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'https',
      },
    });
    const sseChunk = await new Promise((resolve, reject) => {
      sseReq.on('response', (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.includes('\n\n')) resolve({ status: res.statusCode, headers: res.headers, raw: buf });
        });
      });
      sseReq.on('error', reject);
      sseReq.setTimeout(2000, () => reject(new Error('SSE timed out')));
    });
    try {
      assert.equal(sseChunk.status, 200);
      assert.match(sseChunk.raw, /event: endpoint\ndata: \/messages\?sessionId=[0-9a-f-]+\n\n/);
      assert.equal(sseChunk.raw.includes('evil.example'), false);
      assert.equal(sseChunk.raw.includes('http'), false);
      assertNoCors({ headers: sseChunk.headers, raw: sseChunk.raw });
      const sessionId = sseChunk.raw.match(/sessionId=([0-9a-f-]+)/)[1];

      const posted = await request({
        port,
        method: 'POST',
        path: `/messages?sessionId=${sessionId}`,
        headers: trustedHeaders(),
        body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'builtin__list_directory', arguments: { path: '/' } } },
      });
      assert.equal(posted.status, 202);
      assert.equal(posted.raw.includes('ran:'), false);

      const configRpc = await request({
        port,
        method: 'POST',
        path: `/messages?sessionId=${sessionId}`,
        headers: trustedHeaders(),
        body: { jsonrpc: '2.0', id: 9, method: 'custom-tools/create', params: { command: 'bash' } },
      });
      assert.equal(configRpc.status, 202);
    } finally {
      sseReq.destroy();
    }
    assert.deepEqual(inner.calls.map((call) => call.name), ['peekaboo__permissions']);
  });
});

test('real manager does not spawn or exec for denied tools or foreign server config', async () => {
  const marker = path.join(os.tmpdir(), `bridge-should-not-exist-${process.pid}`);
  fs.rmSync(marker, { force: true });
  let execs = 0;
  let spawns = 0;
  const origExec = childProcess.execSync;
  const origSpawn = childProcess.spawn;
  childProcess.execSync = (...args) => {
    execs += 1;
    return origExec(...args);
  };
  childProcess.spawn = (...args) => {
    spawns += 1;
    return origSpawn(...args);
  };
  try {
    const manager = new McpManager({
      evil: { command: '/bin/bash', args: ['-lc', `touch ${marker}`] },
      peekaboo: { command: '/bin/bash', args: ['-lc', `touch ${marker}`], env: { PEEKABOO_ALLOW_TOOLS: 'click,type,shell' } },
    }, policy());
    await manager._startServer('evil', { command: '/bin/bash', args: ['-lc', `touch ${marker}`] });
    await manager._startServer('peekaboo', { command: '/bin/bash', args: ['mcp'] });
    await manager._startServer('peekaboo', { command: '/opt/homebrew/bin/peekaboo', args: ['mcp', '--extra'] });
    assert.equal(manager.servers.size, 0);

    const idle = new McpManager({
      evil: { command: '/bin/bash', args: ['-lc', `touch ${marker}`] },
    }, policy({ peekaboo: { enabled: false, tools: [] } }));
    await idle.startAll();
    assert.equal(idle.servers.size, 0);
    assert.equal(spawns, 0);

    await assert.rejects(() => manager.callTool('custom__music_play', { name: 'ignored' }), (err) => err.denied === true);
    await assert.rejects(() => manager.callTool('builtin__list_directory', { path: '/' }), (err) => err.denied === true);
    await assert.rejects(() => manager.callTool('peekaboo__click', {}), (err) => err.denied === true);
    await assert.rejects(
      () => manager.callTool('peekaboo__permissions', {}),
      (err) => err.statusCode === 503 && err.denied !== true
    );
    assert.equal(execs, 0);
    assert.equal(spawns, 0);
    assert.equal(fs.existsSync(marker), false);

    assert.throws(() => setBraveKey('sekret-value'), (err) => err.denied === true);
    assert.throws(() => setOsaurusKey('osk-v1.sekret'), (err) => err.denied === true);
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      assert.equal(fs.readFileSync(envPath, 'utf8').includes('sekret-value'), false);
    }
  } finally {
    childProcess.execSync = origExec;
    childProcess.spawn = origSpawn;
    fs.rmSync(marker, { force: true });
  }
});
