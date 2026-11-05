'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createApp, listenHttp } = require('../server');
const { normalizePolicy } = require('../security-policy');
const diagnostics = require('../diagnostics');

const CAP = 'example.com/cap/ollamachat-bridge';

function policy(ollamaProxy) {
  return normalizePolicy({
    policyVersion: 1,
    bindHost: '127.0.0.1',
    port: 3100,
    allowedHosts: ['localhost'],
    allowedLogins: ['operator@example.com'],
    requiredAppCapability: CAP,
    ollamaProxy,
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
    Authorization: 'Bearer local-key-should-not-forward',
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
          Accept: 'text/event-stream',
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

function startMock(onHit) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('aborted', () => { req.sawAbort = true; });
    req.on('close', () => { req.sawClose = true; });
    req.on('end', () => {
      const hit = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        req,
        res,
      };
      hits.push(hit);
      onHit(hit);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        hits,
        openUpstream({ method, path, headers }) {
          return http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers });
        },
        close() { return new Promise((done) => server.close(done)); },
      });
    });
  });
}

async function withBridge(ollamaProxy, openUpstream, fn) {
  const { app } = createApp({
    policy: policy(ollamaProxy),
    manager: {
      getStatus: () => ({ peekaboo: 'connected' }),
      async getTools() { return []; },
      async callTool() { throw new Error('mcp should not run'); },
      async startAll() {},
      stopAll() {},
    },
    openUpstream,
  });
  const server = await listenHttp(app, { host: '127.0.0.1', port: 0 });
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('OpenAI model list and streamed tool calls stay on the fixed loopback upstream', async () => {
  diagnostics.reset();
  const prompt = 'SENTINEL_VANTA_PROMPT';
  const mock = await startMock((hit) => {
    if (hit.url === '/v1/models') {
      hit.res.setHeader('Content-Type', 'application/json');
      hit.res.end(JSON.stringify({ object: 'list', data: [{ id: 'gemma4:12b', object: 'model' }] }));
      return;
    }
    hit.res.setHeader('Content-Type', 'text/event-stream');
    hit.res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'peekaboo__permissions', arguments: '' } }] } }],
    })}\n\n`);
    setTimeout(() => {
      hit.res.write('data: [DONE]\n\n');
      hit.res.end();
    }, 15);
  });
  try {
    await withBridge(true, mock.openUpstream, async (port) => {
      const models = await request({ port, method: 'GET', path: '/v1/models', headers: trusted() });
      assert.equal(models.status, 200);
      assert.equal(models.json.data[0].id, 'gemma4:12b');
      assert.equal(models.headers['access-control-allow-origin'], undefined);

      const chat = await request({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: trusted(),
        body: {
          model: 'gemma4:12b',
          stream: true,
          messages: [{ role: 'user', content: prompt }],
          tools: [{ type: 'function', function: { name: 'peekaboo__permissions', parameters: { type: 'object', properties: {} } } }],
        },
      });
      assert.equal(chat.status, 200);
      assert.equal(chat.headers['content-type'], 'text/event-stream');
      assert.match(chat.raw, /data: \[DONE\]/);
      assert.match(chat.raw, /peekaboo__permissions/);

      const denied = await request({
        port,
        method: 'POST',
        path: '/v1/embeddings',
        headers: trusted(),
        body: { model: 'gemma4:12b', input: prompt },
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.reason, 'forbidden_ollama');
    });
    assert.deepEqual(mock.hits.map((hit) => `${hit.method} ${hit.url}`), [
      'GET /v1/models',
      'POST /v1/chat/completions',
    ]);
    const chatHit = mock.hits[1];
    const forwarded = JSON.parse(chatHit.body);
    assert.equal(forwarded.tools[0].function.name, 'peekaboo__permissions');
    assert.equal(forwarded.messages[0].content, prompt);
    assert.equal(chatHit.headers.authorization, undefined);
    assert.equal(chatHit.headers['tailscale-user-login'], undefined);
    assert.equal(chatHit.headers['tailscale-app-capabilities'], undefined);
    assert.equal(chatHit.headers.accept, 'text/event-stream');
    const joined = diagnostics.snapshot().join('\n');
    assert.equal(joined.includes(prompt), false);
    assert.equal(joined.includes('local-key-should-not-forward'), false);
    assert.equal(joined.includes('operator@example.com'), false);
    assert.match(joined, /\[diag\] GET \/v1\/models 200/);
    assert.match(joined, /\[diag\] POST \/v1\/chat\/completions 200 request_tools=1 request_tool_names=peekaboo__permissions response_tool_calls=1 response_tool_names=peekaboo__permissions/);
    assert.match(joined, /\[diag\] POST \/v1\/embeddings 403/);
  } finally {
    await mock.close();
  }
});

test('other /v1 routes and unauthenticated clients do not reach Ollama', async () => {
  const mock = await startMock(() => { throw new Error('upstream should not be contacted'); });
  try {
    await withBridge(true, mock.openUpstream, async (port) => {
      const missing = await request({ port, method: 'GET', path: '/v1/models' });
      assert.equal(missing.status, 403);
      assert.equal(missing.json.reason, 'forbidden_identity');
      const funnel = await request({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: trusted({ 'Tailscale-Funnel-Request': '?1' }),
        body: { model: 'gemma4:12b', messages: [] },
      });
      assert.equal(funnel.status, 403);
      assert.equal(funnel.json.reason, 'forbidden_funnel');
      const origin = await request({
        port,
        method: 'GET',
        path: '/v1/models',
        headers: trusted({ Origin: 'https://evil.example' }),
      });
      assert.equal(origin.status, 403);
      assert.equal(origin.json.reason, 'forbidden_origin');
      const bypass = await request({ port, method: 'GET', path: '/v1/models/../chat/completions', headers: trusted() });
      assert.equal(bypass.status, 403);
      assert.equal(bypass.json.reason, 'forbidden_ollama');
    });
    await withBridge(false, mock.openUpstream, async (port) => {
      const off = await request({ port, method: 'GET', path: '/v1/models', headers: trusted() });
      assert.equal(off.status, 404);
      assert.equal(off.json.reason, 'ollama_disabled');
    });
    assert.equal(mock.hits.length, 0);
  } finally {
    await mock.close();
  }
});

test('OpenAI SSE disconnect aborts the upstream and a paused client applies backpressure', async () => {
  const mock = await startMock((hit) => {
    if (hit.url.endsWith('/cancel')) return;
    if (hit.req.url === '/v1/chat/completions' && hit.body.includes('stop-now')) {
      hit.res.setHeader('Content-Type', 'text/event-stream');
      hit.res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      return;
    }
    hit.res.setHeader('Content-Type', 'text/event-stream');
    const chunk = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(1024) } }] })}\n\n`);
    const pump = () => {
      if (hit.blocked || hit.res.writableEnded) return;
      const ok = hit.res.write(chunk);
      if (!ok) {
        hit.blocked = true;
        return;
      }
      setImmediate(pump);
    };
    pump();
  });
  try {
    await withBridge(true, mock.openUpstream, async (port) => {
      await new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify({
          model: 'gemma4:12b',
          stream: true,
          messages: [{ role: 'user', content: 'stop-now' }],
        }));
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            Host: `127.0.0.1:${port}`,
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            ...trusted(),
          },
        }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', (err) => {
          if (err.code === 'ECONNRESET') resolve();
          else reject(err);
        });
        req.end(payload);
      });
      await new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify({
          model: 'gemma4:12b',
          stream: true,
          messages: [{ role: 'user', content: 'fill' }],
        }));
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            Host: `127.0.0.1:${port}`,
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            ...trusted(),
          },
        }, (res) => {
          res.pause();
          const started = Date.now();
          const wait = setInterval(() => {
            if (mock.hits.some((hit) => hit.blocked)) {
              clearInterval(wait);
              req.destroy();
              resolve();
            } else if (Date.now() - started > 1000) {
              clearInterval(wait);
              req.destroy();
              reject(new Error('SSE upstream write was not paused'));
            }
          }, 10);
        });
        req.on('error', () => {});
        req.end(payload);
      });
    });
    const cancelled = mock.hits.find((hit) => hit.body.includes('stop-now'));
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const wait = setInterval(() => {
        if (cancelled.req.sawClose || cancelled.req.sawAbort) {
          clearInterval(wait);
          resolve();
        } else if (Date.now() - started > 1000) {
          clearInterval(wait);
          reject(new Error('SSE upstream request was not aborted'));
        }
      }, 10);
    });
  } finally {
    await mock.close();
  }
});
