'use strict';

/**
 * server.js
 * MCP-to-HTTP bridge for OllamaChat.
 *
 * Listens on loopback only. Every HTTP, SSE, and Streamable HTTP path is
 * gated by bridge-policy.json. Tailscale Serve is the supported remote path:
 * the iOS app sends a URL and no bearer token, and Serve attaches identity
 * headers. Configuration and custom-tool routes cannot mutate the process.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const { McpManager } = require('./mcp-manager');
const { createSSEHandler } = require('./sse-handler');
const { createStreamableHandler } = require('./streamable-handler');
const {
  PolicyError,
  assertLoopbackHost,
  authorizeHttp,
  defaultPolicy,
  loadPolicyFile,
  toolAllowed,
} = require('./security-policy');
const { proxyOllama } = require('./ollama-proxy');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config' && args[i + 1]) result.config = args[++i];
    if (args[i] === '--port' && args[i + 1]) result.port = parseInt(args[++i], 10);
    if (args[i] === '--host' && args[i + 1]) result.host = args[++i];
  }
  return result;
}

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] [server] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${ts()}] [server] ERROR: ${msg}`, err ? err.stack || err.message || err : '');
}

function guardManager(inner, policy) {
  return {
    getStatus() {
      return inner.getStatus();
    },
    async getTools() {
      const tools = await inner.getTools();
      return tools.filter((tool) => tool && toolAllowed(policy, tool.name));
    },
    async getToolsOpenAI() {
      const tools = await this.getTools();
      return tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },
    async callTool(name, args) {
      if (!toolAllowed(policy, name)) {
        const err = new Error('Tool denied');
        err.statusCode = 403;
        err.denied = true;
        throw err;
      }
      return inner.callTool(name, args);
    },
    startAll() {
      return inner.startAll();
    },
    stopAll() {
      return inner.stopAll();
    },
  };
}

function forbid(res, status, reason) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: status === 404 ? 'Not found' : 'Forbidden', reason });
}

function createApp(options = {}) {
  const policy = options.policy || defaultPolicy();
  const inner = options.manager || new McpManager({}, policy);
  const manager = guardManager(inner, policy);
  const openUpstream = options.openUpstream;
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const decision = authorizeHttp(policy, req);
    if (!decision.ok) return forbid(res, decision.status, decision.reason);
    if (decision.route === 'mutation') return forbid(res, 403, 'forbidden_configuration');
    if (decision.route === 'ollama-denied') return forbid(res, 403, 'forbidden_ollama');
    if (decision.route === 'ollama-disabled') return forbid(res, 404, 'ollama_disabled');
    if (decision.route === 'unknown') return forbid(res, 404, 'not_found');
    if (decision.route === 'ollama') {
      return proxyOllama(req, res, openUpstream ? { openUpstream } : {});
    }
    return next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    const servers = manager.getStatus();
    const allOk = Object.values(servers).every((state) => state === 'connected');
    res.status(allOk ? 200 : 207).json({
      status: allOk ? 'ok' : 'degraded',
      servers,
    });
  });

  app.get('/tools', async (_req, res) => {
    try {
      const tools = await manager.getTools();
      res.json({ tools });
    } catch (err) {
      logError('GET /tools failed', err);
      res.status(500).json({ error: 'Failed to retrieve tools' });
    }
  });

  app.get('/tools/openai', async (_req, res) => {
    try {
      const tools = await manager.getToolsOpenAI();
      res.json(tools);
    } catch (err) {
      logError('GET /tools/openai failed', err);
      res.status(500).json({ error: 'Failed to retrieve OpenAI tools' });
    }
  });

  app.post('/call', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Bad request', detail: 'JSON object required' });
    }
    const { name, arguments: args } = body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'Bad request',
        detail: 'Body must include "name" (string) field',
      });
    }
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return res.status(400).json({ error: 'Bad request', detail: '"arguments" must be an object' });
    }
    try {
      const result = await manager.callTool(name, args || {});
      return res.json(result);
    } catch (err) {
      if (err.denied) {
        return res.status(403).json({ error: 'Tool denied', isError: true });
      }
      const statusCode = err.statusCode || 500;
      logError(`POST /call failed`, err);
      return res.status(statusCode).json({
        error: statusCode === 403 ? 'Tool denied' : 'Tool call failed',
        isError: true,
      });
    }
  });

  const sse = createSSEHandler(manager);
  app.get('/sse', sse.handleSSE);
  app.post('/messages', sse.handleMessages);

  const streamable = createStreamableHandler(manager);
  app.post('/mcp', streamable.handlePost);
  app.get('/mcp', streamable.handleGet);
  app.delete('/mcp', streamable.handleDelete);

  app.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(400).json({ error: 'Bad request' });
    }
    logError('Unhandled express error', err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return { app, policy, manager, inner };
}

function listenHttp(app, options = {}) {
  const host = assertLoopbackHost(options.host === undefined ? '127.0.0.1' : options.host);
  const port = options.port === undefined ? 3100 : options.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new PolicyError('port must be an integer from 0 to 65535');
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

function resolvePolicy(policyPath) {
  if (fs.existsSync(policyPath)) return loadPolicyFile(policyPath);
  if (process.env.BRIDGE_POLICY || process.argv.includes('--config')) {
    throw new PolicyError(`Policy file not found: ${policyPath}`);
  }
  log(`No policy file at ${policyPath} — fail-closed defaults (no logins, Peekaboo disabled)`);
  return defaultPolicy();
}

function setupShutdown(manager, server) {
  const shutdown = (signal) => {
    log(`${signal} received — shutting down`);
    manager.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function main() {
  const cli = parseArgs();
  const policyPath = cli.config || process.env.BRIDGE_POLICY || path.join(__dirname, 'bridge-policy.json');
  log('MCP-to-HTTP bridge starting');
  log(`Policy: ${policyPath}`);

  const policy = resolvePolicy(policyPath);
  if (cli.port) policyStrictPort(policy, cli.port);
  const host = assertLoopbackHost(cli.host || policy.bindHost);
  const port = cli.port || policy.port;

  const { app, manager } = createApp({ policy });
  await manager.startAll();

  const server = await listenHttp(app, { host, port });
  const bound = server.address();
  log(`HTTP server listening on ${bound.address}:${bound.port}`);
  log('Remote access is only via a private Tailscale Serve proxy to this loopback port.');
  setupShutdown(manager, server);
}

function policyStrictPort(policy, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PolicyError('Refusing --port value');
  }
  return policy;
}

if (require.main === module) {
  main().catch((err) => {
    logError('Fatal startup error', err);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  listenHttp,
  guardManager,
  resolvePolicy,
  parseArgs,
};
