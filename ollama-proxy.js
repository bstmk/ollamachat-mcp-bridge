'use strict';

/**
 * Optional reverse proxy to the local Ollama API.
 *
 * The upstream is fixed at 127.0.0.1:11434. Callers cannot supply a URL.
 * Only the read and chat routes OllamaChat needs are forwarded. Model
 * download, copy, delete, create, and blob routes are refused before any
 * socket to Ollama is opened.
 */

const http = require('http');
const { chatRequestTools, ndjsonToolCalls } = require('./diagnostics');

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 11434;

const SHOW_MAX_BYTES = 256 * 1024;
const CHAT_MAX_BYTES = 2 * 1024 * 1024;

const ALLOWED = Object.freeze({
  'GET /api/version': Object.freeze({ body: false, maxBytes: 0, headerTimeoutMs: 10_000, idleTimeoutMs: 10_000 }),
  'GET /api/tags': Object.freeze({ body: false, maxBytes: 0, headerTimeoutMs: 10_000, idleTimeoutMs: 15_000 }),
  'POST /api/show': Object.freeze({ body: true, maxBytes: SHOW_MAX_BYTES, headerTimeoutMs: 15_000, idleTimeoutMs: 30_000 }),
  'POST /api/chat': Object.freeze({ body: true, maxBytes: CHAT_MAX_BYTES, headerTimeoutMs: 15_000, idleTimeoutMs: 120_000 }),
  'POST /api/generate': Object.freeze({ body: true, maxBytes: CHAT_MAX_BYTES, headerTimeoutMs: 15_000, idleTimeoutMs: 120_000 }),
  'GET /v1/models': Object.freeze({ body: false, maxBytes: 0, headerTimeoutMs: 10_000, idleTimeoutMs: 15_000 }),
  'POST /v1/chat/completions': Object.freeze({ body: true, maxBytes: CHAT_MAX_BYTES, headerTimeoutMs: 15_000, idleTimeoutMs: 120_000, sse: true }),
});

const HOP_AND_IDENTITY = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'authorization',
  'cookie',
  'cookie2',
  'set-cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-app-capabilities',
  'tailscale-funnel-request',
  'tailscale-headers-info',
]);

function loopbackLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (hostname !== UPSTREAM_HOST) {
    cb(new Error('refusing non-loopback upstream'));
    return;
  }
  cb(null, UPSTREAM_HOST, 4);
}

const upstreamAgent = new http.Agent({ keepAlive: false, maxSockets: 16 });

function openUpstream({ method, path, headers }) {
  if (typeof method !== 'string' || typeof path !== 'string') {
    throw new Error('refusing upstream request');
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, `${method} ${path}`)) {
    throw new Error('refusing upstream path');
  }
  const safeHeaders = { ...(headers || {}), host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  return http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method,
    path,
    headers: safeHeaders,
    lookup: loopbackLookup,
    agent: upstreamAgent,
  });
}

function isSuspiciousOllamaUrl(rawUrl) {
  const raw = String(rawUrl || '');
  if (raw.includes('\0') || raw.includes('\\') || raw.includes('@') || raw.includes('#')) return true;
  const queryAt = raw.indexOf('?');
  const pathPart = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  if (query.length > 0) return true;
  if (pathPart.includes('..') || pathPart.includes('//') || pathPart.includes('%') || /\s/.test(pathPart)) {
    return true;
  }
  return false;
}

function canonicalOllamaPath(expressPath) {
  let value = String(expressPath || '');
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function classifyOllamaRoute(method, expressPath, rawUrl, proxyEnabled) {
  const pathValue = canonicalOllamaPath(expressPath);
  const raw = String(rawUrl || '');
  const lowerPath = pathValue.toLowerCase();
  const lowerRaw = raw.toLowerCase();
  const looksLikeApi = lowerPath.startsWith('/api') || lowerPath.startsWith('/v1')
    || lowerRaw.includes('/api') || lowerRaw.includes('/v1');
  if (!looksLikeApi) return null;
  if (isSuspiciousOllamaUrl(rawUrl) || isSuspiciousOllamaUrl(pathValue)) return 'ollama-denied';
  const key = `${String(method || '').toUpperCase()} ${pathValue}`;
  if (Object.prototype.hasOwnProperty.call(ALLOWED, key)) {
    return proxyEnabled ? 'ollama' : 'ollama-disabled';
  }
  return 'ollama-denied';
}

function upstreamRequestHeaders(req, limits) {
  const headers = {
    host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
    accept: limits.sse ? 'text/event-stream, application/json' : 'application/json, application/x-ndjson',
  };
  const contentType = req.headers['content-type'];
  if (limits.body) {
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) {
      return null;
    }
    headers['content-type'] = 'application/json';
  }
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.length > 0 && accept.length <= 200 && !/[\r\n]/.test(accept)) {
    headers.accept = accept;
  }
  return headers;
}

function safeResponseContentType(value) {
  if (typeof value !== 'string') return 'application/json';
  const type = value.split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type === 'application/x-ndjson' || type === 'text/event-stream') return type;
  return 'application/octet-stream';
}

function readBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const fail = (error) => {
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
      req.removeAllListeners('aborted');
      reject(error);
    };
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      if (!/^\d+$/.test(String(declared)) || Number(declared) > maxBytes) {
        fail(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
    }
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', fail);
    req.on('aborted', () => fail(Object.assign(new Error('client aborted'), { statusCode: 400 })));
  });
}

function proxyOllama(req, res, deps) {
  const method = String(req.method || '').toUpperCase();
  const pathValue = canonicalOllamaPath(req.path);
  const limits = ALLOWED[`${method} ${pathValue}`];
  const open = deps.openUpstream || openUpstream;
  if (!limits) {
    res.status(403).json({ error: 'Forbidden', reason: 'forbidden_ollama' });
    return;
  }
  const headers = upstreamRequestHeaders(req, limits);
  if (!headers) {
    req.resume();
    res.status(415).json({ error: 'Unsupported media type' });
    return;
  }

  const startUpstream = (body) => {
    const observeTools = pathValue === '/api/chat' || pathValue === '/v1/chat/completions';
    const responseTools = observeTools ? ndjsonToolCalls() : null;
    if (observeTools && typeof deps.onDiagnostic === 'function') {
      deps.onDiagnostic(chatRequestTools(body));
    }
    if (limits.body) headers['content-length'] = String(body.length);
    let upstreamReq;
    try {
      upstreamReq = open({ method, path: pathValue, headers });
    } catch (err) {
      res.status(502).json({ error: 'Bad gateway', reason: 'upstream_unavailable' });
      return;
    }
    let settled = false;
    let idle = null;
    const fail = (status, reason) => {
      if (settled) {
        if (!upstreamReq.destroyed) upstreamReq.destroy();
        if (!res.writableEnded) res.destroy();
        return;
      }
      settled = true;
      if (idle) idle.clear();
      if (!upstreamReq.destroyed) upstreamReq.destroy();
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      res.status(status).json({ error: status === 504 ? 'Gateway timeout' : 'Bad gateway', reason });
    };
    const armIdle = (ms) => {
      let timer = setTimeout(() => fail(504, 'upstream_timeout'), ms);
      if (typeof timer.unref === 'function') timer.unref();
      return {
        bump() {
          clearTimeout(timer);
          timer = setTimeout(() => fail(504, 'upstream_timeout'), ms);
          if (typeof timer.unref === 'function') timer.unref();
        },
        clear() { clearTimeout(timer); },
      };
    };
    idle = armIdle(limits.headerTimeoutMs);
    const abortUpstream = () => {
      if (idle) idle.clear();
      if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy();
    };
    req.on('aborted', abortUpstream);
    res.on('close', () => {
      if (!res.writableEnded) abortUpstream();
    });
    upstreamReq.on('error', () => fail(502, 'upstream_unavailable'));
    upstreamReq.on('timeout', () => fail(504, 'upstream_timeout'));
    upstreamReq.on('response', (upstreamRes) => {
      if (idle) idle.clear();
      const status = upstreamRes.statusCode || 502;
      if (status >= 300 && status < 400) {
        upstreamRes.destroy();
        fail(502, 'upstream_redirect_refused');
        return;
      }
      if (settled || res.headersSent) {
        upstreamRes.destroy();
        return;
      }
      settled = true;
      idle = armIdle(limits.idleTimeoutMs);
      res.status(status);
      res.setHeader('Content-Type', safeResponseContentType(upstreamRes.headers['content-type']));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      upstreamRes.on('data', (chunk) => {
        idle.bump();
        if (responseTools) responseTools.push(chunk);
        const ok = res.write(chunk);
        if (!ok) upstreamRes.pause();
      });
      res.on('drain', () => {
        if (!upstreamRes.destroyed) upstreamRes.resume();
      });
      upstreamRes.on('end', () => {
        idle.clear();
        if (responseTools && typeof deps.onDiagnostic === 'function') {
          deps.onDiagnostic(responseTools.finish());
        }
        res.end();
      });
      upstreamRes.on('error', () => {
        idle.clear();
        res.destroy();
      });
      upstreamRes.on('aborted', () => {
        idle.clear();
        if (!res.writableEnded) res.destroy();
      });
    });
    if (limits.body) upstreamReq.end(body);
    else upstreamReq.end();
  };

  if (!limits.body) {
    startUpstream(Buffer.alloc(0));
    return;
  }
  readBoundedBody(req, limits.maxBytes).then(
    (body) => startUpstream(body),
    (err) => {
      const status = err.statusCode || 400;
      if (!res.headersSent) res.status(status).json({ error: status === 413 ? 'Payload too large' : 'Bad request' });
    }
  );
}

module.exports = {
  UPSTREAM_HOST,
  UPSTREAM_PORT,
  ALLOWED,
  HOP_AND_IDENTITY,
  openUpstream,
  classifyOllamaRoute,
  proxyOllama,
  upstreamRequestHeaders,
};
