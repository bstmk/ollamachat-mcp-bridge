'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createApp, listenHttp } = require('../server');
const { normalizePolicy } = require('../security-policy');
const diagnostics = require('../diagnostics');

const CAP = 'example.com/cap/ollamachat-bridge';
const SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function policy() {
  return normalizePolicy({
    policyVersion: 1,
    bindHost: '127.0.0.1',
    port: 3100,
    allowedHosts: ['localhost'],
    allowedLogins: ['operator@example.com'],
    requiredAppCapability: CAP,
    ollamaProxy: true,
    peekaboo: {
      enabled: true,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: ['permissions'],
    },
  });
}

function trusted(extra = {}) {
  return {
    'Tailscale-User-Login': 'operator@example.com',
    'Tailscale-App-Capabilities': JSON.stringify({ [CAP]: [{ role: 'caller' }] }),
    ...extra,
  };
}

function request({ port, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Host: `127.0.0.1:${port}`,
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
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('discovery responses keep the public upstream shapes and the chat tools field is forwarded', async () => {
  diagnostics.reset();
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.end(`${JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'peekaboo__permissions', arguments: {} } }],
        },
        done: true,
      })}\n`);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const manager = {
    getStatus: () => ({ peekaboo: 'connected' }),
    async getTools() {
      return [{
        name: 'peekaboo__permissions',
        description: 'Report permission state',
        inputSchema: SCHEMA,
        server: 'peekaboo',
      }];
    },
    async callTool(name) {
      return { content: [{ type: 'text', text: 'ok' }], isError: false, name };
    },
    async startAll() {},
    stopAll() {},
  };
  const { app } = createApp({
    policy: policy(),
    manager,
    openUpstream({ method, path, headers }) {
      return http.request({ host: '127.0.0.1', port: upstreamPort, method, path, headers });
    },
  });
  const server = await listenHttp(app, { host: '127.0.0.1', port: 0 });
  const port = server.address().port;
  try {
    const listed = await request({
      port,
      method: 'GET',
      path: '/tools?session=SECRETQUERY',
      headers: trusted(),
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.json).sort(), ['tools']);
    assert.deepEqual(listed.json.tools, [{
      name: 'peekaboo__permissions',
      description: 'Report permission state',
      inputSchema: SCHEMA,
      server: 'peekaboo',
    }]);

    const openai = await request({ port, method: 'GET', path: '/tools/openai', headers: trusted() });
    assert.equal(openai.status, 200);
    assert.ok(Array.isArray(openai.json));
    assert.deepEqual(openai.json, [{
      type: 'function',
      function: {
        name: 'peekaboo__permissions',
        description: 'Report permission state',
        parameters: SCHEMA,
      },
    }]);

    const prompt = 'SENTINEL_PROMPT_do_not_log';
    const chatBody = {
      model: 'gemma4:12b',
      messages: [{ role: 'user', content: prompt }],
      tools: openai.json,
    };
    const chat = await request({
      port,
      method: 'POST',
      path: '/api/chat',
      headers: trusted(),
      body: chatBody,
    });
    assert.equal(chat.status, 200);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, '/api/chat');
    assert.deepEqual(JSON.parse(hits[0].body).tools, openai.json);
    assert.equal(hits[0].body.includes(prompt), true);

    const called = await request({
      port,
      method: 'POST',
      path: '/call',
      headers: trusted(),
      body: { name: 'peekaboo__permissions', arguments: {} },
    });
    assert.equal(called.status, 200);
    assert.equal(called.json.isError, false);

    const hidden = await request({ port, method: 'GET', path: '/diagnostics', headers: trusted() });
    assert.equal(hidden.status, 404);

    const lines = diagnostics.snapshot();
    const joined = lines.join('\n');
    assert.equal(joined.includes(prompt), false);
    assert.equal(joined.includes('SECRETQUERY'), false);
    assert.equal(joined.includes('operator@example.com'), false);
    assert.equal(joined.includes('Tailscale'), false);
    assert.match(joined, /\[diag\] GET \/tools 200 tools=1 names=peekaboo__permissions/);
    assert.match(joined, /\[diag\] GET \/tools\/openai 200 tools=1 names=peekaboo__permissions/);
    assert.match(joined, /\[diag\] POST \/api\/chat 200 request_tools=1 request_tool_names=peekaboo__permissions response_tool_calls=1 response_tool_names=peekaboo__permissions/);
    assert.match(joined, /\[diag\] POST \/call 200 tool=peekaboo__permissions/);
    assert.match(joined, /\[diag\] GET \/diagnostics 404/);
    assert.equal(lines.some((line) => line.includes('?')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
