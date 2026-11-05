'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createApp, listenHttp } = require('../server');
const { normalizePolicy, PolicyError } = require('../security-policy');
const { openUpstream, UPSTREAM_HOST, UPSTREAM_PORT } = require('../ollama-proxy');

const CAP = 'example.com/cap/ollamachat-bridge';

function policy(ollamaProxy) {
  return normalizePolicy({
    policyVersion: 1,
    bindHost: '127.0.0.1',
    port: 3100,
    allowedHosts: ['localhost', 'mac-studio.example.ts.net'],
    allowedLogins: ['operator@example.com'],
    requiredAppCapability: CAP,
    identityMode: 'user',
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
    Authorization: 'Bearer should-not-forward',
    Cookie: 'session=should-not-forward',
    ...extra,
  };
}

function request({ port, method, path, headers, body, host }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
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
        resolve({ status: res.statusCode, headers: res.headers, raw, json, req });
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
    req.on('aborted', () => { req.sawAbort = true; });
    req.on('close', () => { req.sawClose = true; });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        hits,
        server,
        openUpstream({ method, path, headers }) {
          return http.request({ host: '127.0.0.1', port, method, path, headers });
        },
        close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

async function withBridge(ollamaProxy, openUpstreamFn, fn) {
  const { app } = createApp({
    policy: policy(ollamaProxy),
    manager: {
      calls: [],
      getStatus: () => ({ peekaboo: 'connected' }),
      async getTools() { return []; },
      async callTool() { throw new Error('mcp should not run'); },
      async startAll() {},
      stopAll() {},
    },
    openUpstream: openUpstreamFn,
  });
  const server = await listenHttp(app, { host: '127.0.0.1', port: 0 });
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('upstream socket is fixed to loopback Ollama and ignores a caller host', () => {
  assert.equal(UPSTREAM_HOST, '127.0.0.1');
  assert.equal(UPSTREAM_PORT, 11434);
  const upstream = openUpstream({
    method: 'GET',
    path: '/api/tags',
    headers: { host: 'evil.example:9' },
    host: '169.254.169.254',
    port: 9,
  });
  upstream.on('error', () => {});
  assert.equal(upstream.host, '127.0.0.1');
  assert.equal(upstream.getHeader('host'), '127.0.0.1:11434');
  upstream.destroy();
  assert.throws(() => openUpstream({ method: 'POST', path: '/api/pull', headers: {} }), /upstream path/);
  assert.throws(() => normalizePolicy({
    policyVersion: 1,
    ollamaProxy: { url: 'http://169.254.169.254/latest' },
    peekaboo: {
      enabled: false,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: [],
    },
  }), PolicyError);
  assert.equal(policy(false).ollamaProxy, false);
});

test('disabled proxy and denied Ollama routes never open the upstream', async () => {
  const mock = await startMock(() => {
    throw new Error('upstream should not be contacted');
  });
  try {
    const denied = [
      ['GET', '/api/tags'],
      ['POST', '/api/chat'],
      ['POST', '/api/pull'],
      ['POST', '/api/push'],
      ['POST', '/api/create'],
      ['POST', '/api/copy'],
      ['DELETE', '/api/delete'],
      ['POST', '/api/blobs/sha256:abc'],
      ['HEAD', '/api/blobs/sha256:abc'],
      ['POST', '/api/embed'],
      ['GET', '/api/ps'],
      ['GET', '/api/tags/../pull'],
      ['GET', '/api/%2e%2e/pull'],
      ['GET', '/api/tags?stream=1'],
      ['POST', '/api/generate'],
      ['GET', '/v1/models'],
      ['POST', '/v1/chat/completions'],
      ['POST', '/v1/embeddings'],
    ];
    await withBridge(false, mock.openUpstream, async (port) => {
      for (const [method, path] of denied) {
        const response = await request({
          port,
          method,
          path,
          headers: trusted(),
          body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : { name: 'gemma4:12b' },
        });
        assert.notEqual(response.status, 200, path);
        assert.equal(response.headers['access-control-allow-origin'], undefined);
      }
    });
    await withBridge(true, mock.openUpstream, async (port) => {
      for (const [method, path] of [
        ['POST', '/api/pull'],
        ['POST', '/api/push'],
        ['POST', '/api/create'],
        ['POST', '/api/copy'],
        ['DELETE', '/api/delete'],
        ['POST', '/api/blobs/sha256:abc'],
        ['POST', '/api/embed'],
        ['GET', '/api/ps'],
        ['POST', '/v1/embeddings'],
        ['POST', '/v1/completions'],
        ['POST', '/v1/responses'],
        ['POST', '/v1/files'],
        ['GET', '/v1/files'],
        ['GET', '/v1/models/gemma4:12b'],
        ['DELETE', '/v1/models/gemma4:12b'],
      ]) {
        const response = await request({
          port,
          method,
          path,
          headers: trusted(),
          body: method === 'GET' ? undefined : { model: 'gemma4:12b' },
        });
        assert.equal(response.status, 403, path);
        assert.equal(response.json.reason, 'forbidden_ollama');
      }
      const bypasses = ['/api/tags/../pull', '/api/%2e%2e/pull', '/api/tags?x=1', '/api//chat'];
      for (const path of bypasses) {
        const response = await request({
          port,
          method: 'GET',
          path,
          headers: trusted(),
        });
        assert.equal(response.status, 403, path);
        assert.equal(response.json.reason, 'forbidden_ollama');
      }
      const unauthenticated = await request({ port, method: 'GET', path: '/api/tags' });
      assert.equal(unauthenticated.status, 403);
      assert.equal(unauthenticated.json.reason, 'forbidden_identity');
      const funnel = await request({
        port,
        method: 'POST',
        path: '/api/chat',
        headers: trusted({ 'Tailscale-Funnel-Request': '?1' }),
        body: { model: 'gemma4:12b', messages: [] },
      });
      assert.equal(funnel.status, 403);
      assert.equal(funnel.json.reason, 'forbidden_funnel');
      const origin = await request({
        port,
        method: 'GET',
        path: '/api/version',
        headers: trusted({ Origin: 'https://evil.example' }),
      });
      assert.equal(origin.status, 403);
      assert.equal(origin.json.reason, 'forbidden_origin');
      const huge = await request({
        port,
        method: 'POST',
        path: '/api/chat',
        headers: trusted(),
        body: Buffer.alloc((2 * 1024 * 1024) + 1, 0x7b).toString('utf8'),
      });
      assert.equal(huge.status, 413);
      const textBody = await request({
        port,
        method: 'POST',
        path: '/api/show',
        headers: trusted({ 'Content-Type': 'text/plain' }),
        body: 'model=gemma4',
      });
      assert.equal(textBody.status, 415);
    });
    assert.equal(mock.hits.length, 0);
  } finally {
    await mock.close();
  }
});

test('enabled proxy lists models and streams chat without forwarding identity headers', async () => {
  const mock = await startMock((hit) => {
    if (hit.url === '/api/tags') {
      hit.res.setHeader('Content-Type', 'application/json');
      hit.res.end(JSON.stringify({ models: [{ name: 'gemma4:12b' }] }));
      return;
    }
    if (hit.url === '/api/version') {
      hit.res.setHeader('Content-Type', 'application/json');
      hit.res.end(JSON.stringify({ version: '0.40.13' }));
      return;
    }
    if (hit.url === '/api/show') {
      hit.res.setHeader('Content-Type', 'application/json');
      hit.res.end(JSON.stringify({ model: 'gemma4:12b', details: { family: 'gemma' } }));
      return;
    }
    if (hit.url === '/api/chat') {
      hit.res.setHeader('Content-Type', 'application/x-ndjson');
      hit.res.write(`${JSON.stringify({ message: { content: 'Hel' }, done: false })}\n`);
      setTimeout(() => {
        hit.res.write(`${JSON.stringify({ message: { content: 'lo' }, done: false })}\n`);
        hit.res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
      }, 20);
      return;
    }
    if (hit.url === '/api/generate') {
      hit.res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      hit.res.end();
      return;
    }
    hit.res.statusCode = 500;
    hit.res.end('unexpected');
  });
  try {
    await withBridge(true, mock.openUpstream, async (port) => {
      const tags = await request({ port, method: 'GET', path: '/api/tags', headers: trusted() });
      assert.equal(tags.status, 200);
      assert.equal(tags.json.models[0].name, 'gemma4:12b');
      assert.equal(tags.headers['access-control-allow-origin'], undefined);
      assert.equal(tags.headers.location, undefined);

      const version = await request({ port, method: 'GET', path: '/api/version', headers: trusted() });
      assert.equal(version.json.version, '0.40.13');

      const show = await request({
        port,
        method: 'POST',
        path: '/api/show',
        headers: trusted(),
        body: { model: 'gemma4:12b' },
      });
      assert.equal(show.json.details.family, 'gemma');

      const chat = await request({
        port,
        method: 'POST',
        path: '/api/chat',
        headers: trusted(),
        body: { model: 'gemma4:12b', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(chat.status, 200);
      assert.equal(chat.headers['content-type'], 'application/x-ndjson');
      const lines = chat.raw.trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((line) => line.message.content), ['Hel', 'lo', '']);
      assert.equal(lines[2].done, true);

      const redirect = await request({
        port,
        method: 'POST',
        path: '/api/generate',
        headers: trusted(),
        body: { model: 'gemma4:12b', prompt: 'hi' },
      });
      assert.equal(redirect.status, 502);
      assert.equal(redirect.json.reason, 'upstream_redirect_refused');
      assert.equal(redirect.headers.location, undefined);
      assert.equal(redirect.raw.includes('169.254.169.254'), false);
    });
    assert.deepEqual(mock.hits.map((hit) => `${hit.method} ${hit.url}`), [
      'GET /api/tags',
      'GET /api/version',
      'POST /api/show',
      'POST /api/chat',
      'POST /api/generate',
    ]);
    for (const hit of mock.hits) {
      assert.equal(hit.headers['tailscale-user-login'], undefined);
      assert.equal(hit.headers['tailscale-app-capabilities'], undefined);
      assert.equal(hit.headers['tailscale-funnel-request'], undefined);
      assert.equal(hit.headers.authorization, undefined);
      assert.equal(hit.headers.cookie, undefined);
      assert.equal(hit.headers.host, '127.0.0.1:11434');
    }
    const show = mock.hits.find((hit) => hit.url === '/api/show');
    assert.equal(JSON.parse(show.body).model, 'gemma4:12b');
  } finally {
    await mock.close();
  }
});

test('client abort cancels the upstream stream and a full buffer pauses it', async () => {
  const mock = await startMock((hit) => {
    if (hit.url === '/api/chat') {
      hit.res.setHeader('Content-Type', 'application/x-ndjson');
      hit.res.write(`${JSON.stringify({ message: { content: 'partial' }, done: false })}\n`);
      return;
    }
    const chunk = Buffer.alloc(32 * 1024, 0x61);
    let blocked = false;
    const pump = () => {
      if (blocked || hit.res.writableEnded) return;
      const ok = hit.res.write(chunk);
      if (!ok) {
        blocked = true;
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
          messages: [{ role: 'user', content: 'stop' }],
        }));
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/chat',
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
        req.write(payload);
        req.end();
      });
      await new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify({ model: 'gemma4:12b', prompt: 'x' }));
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/generate',
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
            const generate = mock.hits.find((hit) => hit.url === '/api/generate');
            if (generate && generate.blocked) {
              clearInterval(wait);
              req.destroy();
              resolve();
            } else if (Date.now() - started > 1000) {
              clearInterval(wait);
              req.destroy();
              reject(new Error('upstream write was not paused'));
            }
          }, 10);
        });
        req.on('error', () => {});
        req.write(payload);
        req.end();
      });
    });
    const chat = mock.hits.find((hit) => hit.url === '/api/chat');
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const wait = setInterval(() => {
        if (chat.req.sawClose || chat.req.sawAbort || chat.req.destroyed) {
          clearInterval(wait);
          resolve();
        } else if (Date.now() - started > 1000) {
          clearInterval(wait);
          reject(new Error('upstream chat request was not aborted'));
        }
      }, 10);
    });
    assert.equal(mock.hits.some((hit) => hit.url === '/api/pull'), false);
  } finally {
    await mock.close();
  }
});
