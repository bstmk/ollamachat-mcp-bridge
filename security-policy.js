'use strict';

/**
 * security-policy.js
 *
 * Fail-closed policy for the OllamaChat MCP bridge.
 *
 * Remote callers never change this file. The iOS app only has URL fields, so
 * it cannot send a bearer token. Identity is taken from headers that Tailscale
 * Serve (v1.92+) strips and resets when it proxies to loopback. Those headers
 * are not a secret and are not accepted from a public Funnel request.
 *
 * Tailscale-User-Login is the user, shared by every device that user owns.
 * The operator approved that scope for their own account: every device signed
 * in as that login, with no tag and no per-phone selector in this bridge.
 * The capability header is still required. This module cannot see a node id.
 */

const fs = require('fs');
const path = require('path');
const { classifyOllamaRoute } = require('./ollama-proxy');

const POLICY_VERSION = 1;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 3100;
const DEFAULT_CAPABILITY = 'example.com/cap/ollamachat-bridge';
const PEEKABOO_BASENAME = 'peekaboo';
const REQUIRED_ARGS = ['mcp'];

/** Reviewed against Peekaboo source/docs for 4.9.x. Not executed on macOS. */
const PEEKABOO_MINIMAL = Object.freeze(['permissions']);

/** Screenshot, launch, click, and type. Not a blanket mutating-tool switch. */
const PEEKABOO_GUI = Object.freeze(['image', 'app', 'click', 'type']);

const PEEKABOO_SENSITIVE = Object.freeze([
  'list',
  'inspect_ui',
  'see',
  'image',
  'verify_state',
  'sleep',
]);

const PEEKABOO_MUTATING = Object.freeze([
  'analyze',
  'browser',
  'capture',
  'set_value',
  'select_text',
  'action',
  'scroll',
  'press',
  'hotkey',
  'swipe',
  'drag',
  'move',
  'app',
  'window',
  'menu',
  'clipboard',
  'paste',
  'agent',
  'dock',
  'dialog',
  'space',
  'shell',
  'menu_click',
]);

const PEEKABOO_CATALOG = new Set([
  ...PEEKABOO_MINIMAL,
  ...PEEKABOO_GUI,
  ...PEEKABOO_SENSITIVE,
  ...PEEKABOO_MUTATING,
]);

const BLOCKED_APP_NAMES = new Set([
  'terminal',
  'com.apple.terminal',
  'iterm',
  'iterm2',
  'com.googlecode.iterm2',
  'script editor',
  'scripteditor',
  'com.apple.scripteditor2',
  'automator',
  'com.apple.automator',
  'shortcuts',
  'com.apple.shortcuts',
]);

const PROTOCOL_ROUTES = new Set([
  'GET /health',
  'GET /tools',
  'GET /tools/openai',
  'POST /call',
  'GET /sse',
  'POST /messages',
  'POST /mcp',
  'GET /mcp',
  'DELETE /mcp',
]);

const TOP_LEVEL_FIELDS = new Set([
  'policyVersion',
  'bindHost',
  'port',
  'allowedHosts',
  'allowedOrigins',
  'allowedLogins',
  'requiredAppCapability',
  'identityMode',
  'allowSensitiveObservation',
  'allowGuiControls',
  'allowMutatingTools',
  'ollamaProxy',
  'peekaboo',
]);

const PEEKABOO_FIELDS = new Set(['enabled', 'command', 'args', 'tools']);

class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

function classifyPeekabooTool(name) {
  const normalized = normalizeToolName(name);
  if (PEEKABOO_MINIMAL.includes(normalized)) return 'minimal';
  if (PEEKABOO_GUI.includes(normalized)) return 'gui';
  if (PEEKABOO_SENSITIVE.includes(normalized)) return 'sensitive';
  if (PEEKABOO_MUTATING.includes(normalized)) return 'mutating';
  return 'unknown';
}

function normalizeToolName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

function assertExactKeys(obj, allowed, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new PolicyError(`${label} must be a JSON object`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new PolicyError(`Unknown ${label} field "${key}"`);
    }
  }
}

function assertBoolean(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new PolicyError(`${field} must be a boolean`);
  }
  return value;
}

function assertLoopbackHost(host) {
  const value = host === undefined || host === null || host === '' ? DEFAULT_BIND_HOST : String(host);
  if (value !== '127.0.0.1' && value !== '::1') {
    throw new PolicyError(
      `Refusing bind host "${value}". The bridge listens on 127.0.0.1 (or ::1) only.`
    );
  }
  return value;
}

function validateCommand(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 512) {
    throw new PolicyError('peekaboo.command must be an absolute path to the peekaboo executable');
  }
  if (command.includes('\0') || command.includes('..') || /[\r\n]/.test(command)) {
    throw new PolicyError('peekaboo.command is not an exact executable path');
  }
  if (!path.isAbsolute(command)) {
    throw new PolicyError('peekaboo.command must be an absolute path');
  }
  if (path.basename(command) !== PEEKABOO_BASENAME) {
    throw new PolicyError('peekaboo.command basename must be peekaboo');
  }
  return command;
}

function validateArgs(args) {
  if (!Array.isArray(args) || args.length !== REQUIRED_ARGS.length) {
    throw new PolicyError('peekaboo.args must be exactly ["mcp"]');
  }
  for (let i = 0; i < REQUIRED_ARGS.length; i += 1) {
    if (args[i] !== REQUIRED_ARGS[i]) {
      throw new PolicyError('peekaboo.args must be exactly ["mcp"]');
    }
  }
  return REQUIRED_ARGS.slice();
}

function validateToolList(tools, flags) {
  if (!Array.isArray(tools)) {
    throw new PolicyError('peekaboo.tools must be an array of tool names');
  }
  const out = [];
  const seen = new Set();
  for (const entry of tools) {
    if (typeof entry !== 'string') {
      throw new PolicyError('peekaboo.tools entries must be strings');
    }
    const name = normalizeToolName(entry);
    if (!/^[a-z0-9_]+$/.test(name)) {
      throw new PolicyError(`Invalid Peekaboo tool name "${entry}"`);
    }
    const kind = classifyPeekabooTool(name);
    if (kind === 'unknown' || !PEEKABOO_CATALOG.has(name)) {
      throw new PolicyError(
        `Refusing unreviewed Peekaboo tool "${name}". Unknown tools stay denied.`
      );
    }
    if (kind === 'gui' && !flags.allowGuiControls) {
      throw new PolicyError(
        `Refusing GUI control "${name}" while allowGuiControls is false`
      );
    }
    if (kind === 'sensitive' && !flags.allowSensitiveObservation) {
      throw new PolicyError(
        `Refusing sensitive Peekaboo tool "${name}" while allowSensitiveObservation is false`
      );
    }
    if (kind === 'mutating' && !flags.allowMutatingTools) {
      throw new PolicyError(
        `Refusing mutating Peekaboo tool "${name}" while allowMutatingTools is false`
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function validateLogin(login) {
  if (typeof login !== 'string') {
    throw new PolicyError('allowedLogins entries must be strings');
  }
  const value = login.trim().toLowerCase();
  if (value.length === 0 || value.length > 254 || value.includes('*') || /\s/.test(value)) {
    throw new PolicyError(`Refusing allowed login "${login}"`);
  }
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) {
    throw new PolicyError(`Refusing allowed login "${login}". Use the exact Tailscale login, not a user-wide wildcard.`);
  }
  return value;
}

function validateCapability(value) {
  if (typeof value !== 'string') {
    throw new PolicyError('requiredAppCapability must be a string');
  }
  const cap = value.trim();
  if (cap.length < 3 || cap.length > 128 || !/^[a-z0-9.-]+\/cap\/[a-z0-9][a-z0-9._-]*$/i.test(cap)) {
    throw new PolicyError('requiredAppCapability must look like example.com/cap/ollamachat-bridge');
  }
  if (cap.includes('*') || cap.includes('..')) {
    throw new PolicyError('requiredAppCapability must be an exact capability name');
  }
  return cap;
}

function validateHostname(host) {
  if (typeof host !== 'string') {
    throw new PolicyError('allowedHosts entries must be strings');
  }
  const value = host.trim().toLowerCase().replace(/\.$/, '');
  if (
    value.length === 0 ||
    value.length > 253 ||
    value === '*' ||
    value.includes('*') ||
    value.includes('/') ||
    value.includes('@') ||
    value.includes(' ') ||
    value.includes(':')
  ) {
    throw new PolicyError(`Refusing allowed host "${host}"`);
  }
  return value;
}

function defaultPolicy() {
  return normalizePolicy({
    policyVersion: POLICY_VERSION,
    bindHost: DEFAULT_BIND_HOST,
    port: DEFAULT_PORT,
    allowedHosts: ['localhost'],
    allowedOrigins: [],
    allowedLogins: [],
    requiredAppCapability: DEFAULT_CAPABILITY,
    identityMode: 'user',
    allowSensitiveObservation: false,
    allowGuiControls: false,
    allowMutatingTools: false,
    ollamaProxy: false,
    peekaboo: {
      enabled: false,
      command: '/opt/homebrew/bin/peekaboo',
      args: ['mcp'],
      tools: [],
    },
  });
}

function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyError('Refusing config: expected a policy object with policyVersion 1.');
  }
  if (raw.policyVersion !== POLICY_VERSION) {
    throw new PolicyError(
      'Refusing config: expected policyVersion 1. MCP server command maps are not accepted.'
    );
  }
  assertExactKeys(raw, TOP_LEVEL_FIELDS, 'policy');

  const bindHost = assertLoopbackHost(raw.bindHost === undefined ? DEFAULT_BIND_HOST : raw.bindHost);
  let port = raw.port === undefined ? DEFAULT_PORT : raw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PolicyError('port must be an integer from 1 to 65535');
  }

  const identityMode = raw.identityMode === undefined ? 'user' : raw.identityMode;
  if (identityMode !== 'user' && identityMode !== 'tagged') {
    throw new PolicyError('identityMode must be "user" or "tagged"');
  }

  const allowSensitiveObservation = assertBoolean(
    raw.allowSensitiveObservation,
    'allowSensitiveObservation',
    false
  );
  const allowGuiControls = assertBoolean(raw.allowGuiControls, 'allowGuiControls', false);
  const allowMutatingTools = assertBoolean(raw.allowMutatingTools, 'allowMutatingTools', false);
  const ollamaProxy = assertBoolean(raw.ollamaProxy, 'ollamaProxy', false);

  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const hostList = raw.allowedHosts === undefined ? [] : raw.allowedHosts;
  if (!Array.isArray(hostList)) throw new PolicyError('allowedHosts must be an array');
  for (const host of hostList) allowedHosts.add(validateHostname(host));

  const allowedOrigins = new Set();
  const originList = raw.allowedOrigins === undefined ? [] : raw.allowedOrigins;
  if (!Array.isArray(originList)) throw new PolicyError('allowedOrigins must be an array');
  for (const origin of originList) {
    if (typeof origin !== 'string' || origin === '*' || origin === 'null') {
      throw new PolicyError('allowedOrigins cannot contain * or null');
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch (_) {
      throw new PolicyError(`Invalid allowed origin "${origin}"`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new PolicyError(`Invalid allowed origin "${origin}"`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new PolicyError(`Invalid allowed origin "${origin}"`);
    }
    allowedOrigins.add(parsed.origin);
  }

  const allowedLogins = [];
  const loginList = raw.allowedLogins === undefined ? [] : raw.allowedLogins;
  if (!Array.isArray(loginList)) throw new PolicyError('allowedLogins must be an array');
  for (const login of loginList) allowedLogins.push(validateLogin(login));
  if (identityMode === 'tagged' && allowedLogins.length > 0) {
    throw new PolicyError(
      'identityMode "tagged" does not use Tailscale-User-Login. Leave allowedLogins empty and restrict the grant src to that tagged device.'
    );
  }

  const requiredAppCapability = validateCapability(
    raw.requiredAppCapability === undefined ? DEFAULT_CAPABILITY : raw.requiredAppCapability
  );

  const peekabooRaw = raw.peekaboo === undefined
    ? { enabled: false, command: '/opt/homebrew/bin/peekaboo', args: ['mcp'], tools: [] }
    : raw.peekaboo;
  assertExactKeys(peekabooRaw, PEEKABOO_FIELDS, 'peekaboo');
  const enabled = assertBoolean(peekabooRaw.enabled, 'peekaboo.enabled', false);
  const command = validateCommand(
    peekabooRaw.command === undefined ? '/opt/homebrew/bin/peekaboo' : peekabooRaw.command
  );
  const args = validateArgs(peekabooRaw.args === undefined ? ['mcp'] : peekabooRaw.args);
  const tools = validateToolList(peekabooRaw.tools === undefined ? [] : peekabooRaw.tools, {
    allowSensitiveObservation,
    allowGuiControls,
    allowMutatingTools,
  });

  return Object.freeze({
    policyVersion: POLICY_VERSION,
    bindHost,
    port,
    allowedHosts,
    allowedOrigins,
    allowedLogins: Object.freeze(allowedLogins),
    requiredAppCapability,
    identityMode,
    allowSensitiveObservation,
    allowGuiControls,
    allowMutatingTools,
    ollamaProxy,
    peekaboo: Object.freeze({
      enabled,
      command,
      args: Object.freeze(args),
      tools: Object.freeze(tools),
    }),
  });
}

function loadPolicyFile(filePath) {
  const resolved = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new PolicyError(`Policy file not readable: ${resolved}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PolicyError(`Policy file is not JSON: ${resolved}`);
  }
  return normalizePolicy(parsed);
}

function hostnameFromHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  const value = hostHeader.trim();
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes('/') ||
    value.includes('@') ||
    value.includes(' ') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    return '';
  }
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end <= 1) return '';
    const tail = value.slice(end + 1);
    if (tail !== '' && !/^:\d+$/.test(tail)) return '';
    return value.slice(1, end).toLowerCase();
  }
  const colonCount = value.split(':').length - 1;
  if (colonCount === 1) {
    const colon = value.indexOf(':');
    const port = value.slice(colon + 1);
    if (!/^\d+$/.test(port)) return '';
    return value.slice(0, colon).toLowerCase().replace(/\.$/, '');
  }
  if (colonCount > 1) return '';
  return value.toLowerCase().replace(/\.$/, '');
}

function checkHost(policy, hostHeader) {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname || !policy.allowedHosts.has(hostname)) {
    return { ok: false, status: 403, reason: 'forbidden_host' };
  }
  return { ok: true };
}

function checkOrigin(policy, originHeader) {
  if (originHeader === undefined) return { ok: true };
  if (Array.isArray(originHeader)) return { ok: false, status: 403, reason: 'forbidden_origin' };
  if (typeof originHeader !== 'string' || originHeader === '' || originHeader === 'null' || originHeader === '*') {
    return { ok: false, status: 403, reason: 'forbidden_origin' };
  }
  let parsed;
  try {
    parsed = new URL(originHeader);
  } catch (_) {
    return { ok: false, status: 403, reason: 'forbidden_origin' };
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !policy.allowedOrigins.has(parsed.origin)) {
    return { ok: false, status: 403, reason: 'forbidden_origin' };
  }
  return { ok: true };
}

function decodeRfc2047(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 8192) return '';
  if (/[\r\n\0]/.test(trimmed)) return '';
  const match = trimmed.match(/^=\?([^?]+)\?([qQbB])\?([^?]*)\?=$/);
  if (!match) return trimmed;
  const charset = match[1].toLowerCase();
  if (charset !== 'utf-8' && charset !== 'utf8') return '';
  const encoding = match[2].toLowerCase();
  const text = match[3];
  try {
    if (encoding === 'q') {
      const bytes = [];
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '=') {
          const hex = text.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) return '';
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else if (ch === '_') {
          bytes.push(0x20);
        } else if (ch.charCodeAt(0) > 127) {
          return '';
        } else {
          bytes.push(ch.charCodeAt(0));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    }
    if (encoding === 'b') {
      return Buffer.from(text, 'base64').toString('utf8');
    }
  } catch (_) {
    return '';
  }
  return '';
}

function singleHeader(value) {
  if (value === undefined) return '';
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string') return null;
  return value;
}

function checkIdentity(policy, headers) {
  const funnel = singleHeader(headers['tailscale-funnel-request']);
  if (funnel === null || funnel !== '') {
    return { ok: false, status: 403, reason: 'forbidden_funnel' };
  }

  const loginRaw = singleHeader(headers['tailscale-user-login']);
  const capRaw = singleHeader(headers['tailscale-app-capabilities']);
  if (loginRaw === null || capRaw === null) {
    return { ok: false, status: 403, reason: 'forbidden_identity' };
  }

  const login = decodeRfc2047(loginRaw).trim().toLowerCase();
  const capText = decodeRfc2047(capRaw).trim();
  let caps;
  try {
    caps = JSON.parse(capText);
  } catch (_) {
    return { ok: false, status: 403, reason: 'forbidden_identity' };
  }
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return { ok: false, status: 403, reason: 'forbidden_identity' };
  }
  if (!Object.prototype.hasOwnProperty.call(caps, policy.requiredAppCapability)) {
    return { ok: false, status: 403, reason: 'forbidden_identity' };
  }
  const granted = caps[policy.requiredAppCapability];
  if (!Array.isArray(granted)) {
    return { ok: false, status: 403, reason: 'forbidden_identity' };
  }

  if (policy.identityMode === 'tagged') {
    if (login !== '') {
      return { ok: false, status: 403, reason: 'forbidden_identity' };
    }
    return { ok: true, login: '' };
  }

  if (!login || !policy.allowedLogins.includes(login)) {
    return { ok: false, status: 403, reason: 'forbidden_identity' };
  }
  return { ok: true, login };
}

function routeClass(method, requestPath, rawUrl, policy) {
  const ollamaRoute = classifyOllamaRoute(
    method,
    requestPath,
    rawUrl === undefined ? requestPath : rawUrl,
    Boolean(policy && policy.ollamaProxy)
  );
  if (ollamaRoute) return ollamaRoute;
  const pathname = String(requestPath || '/').split('?')[0];
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (
    normalized === '/config' ||
    normalized.startsWith('/config/') ||
    normalized === '/custom-tools' ||
    normalized.startsWith('/custom-tools/')
  ) {
    return 'mutation';
  }
  const key = `${String(method || '').toUpperCase()} ${normalized}`;
  if (PROTOCOL_ROUTES.has(key)) return 'protocol';
  return 'unknown';
}

function authorizeHttp(policy, req) {
  const host = checkHost(policy, req.headers.host);
  if (!host.ok) return host;
  const origin = checkOrigin(policy, req.headers.origin);
  if (!origin.ok) return origin;
  const identity = checkIdentity(policy, req.headers);
  if (!identity.ok) return identity;
  return {
    ok: true,
    login: identity.login,
    route: routeClass(req.method, req.path, req.originalUrl || req.url, policy),
  };
}

function splitToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0 || toolName.length > 200) return null;
  const sep = toolName.indexOf('__');
  if (sep <= 0 || sep !== toolName.lastIndexOf('__')) return null;
  const server = toolName.slice(0, sep);
  const bare = normalizeToolName(toolName.slice(sep + 2));
  if (server !== 'peekaboo' || !/^[a-z0-9_]+$/.test(bare)) return null;
  return { server, bare };
}

function toolAllowed(policy, toolName) {
  const parts = splitToolName(toolName);
  if (!parts) return false;
  return policy.peekaboo.tools.includes(parts.bare);
}

function denyTool() {
  const err = new Error('Tool denied');
  err.statusCode = 403;
  err.denied = true;
  return err;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function blockedAppTarget(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.length > 200 || /[\r\n\0]/.test(text)) return true;
  if (text.includes('://') || text.startsWith('pid:') || text.includes('/') || text.includes('\\')) return true;
  const bare = text.replace(/\.app$/, '');
  return BLOCKED_APP_NAMES.has(bare);
}

function narrowedInputSchema(bare) {
  if (bare === 'image') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { type: 'string', const: 'data' },
        app_target: { type: 'string' },
        capture_focus: { type: 'string', enum: ['background', 'auto', 'foreground'] },
        scale: { type: 'string', enum: ['logical', '1x', 'native', 'retina', '2x'] },
        retina: { type: 'boolean' },
      },
    };
  }
  if (bare === 'app') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['launch'] },
        name: { type: 'string' },
        bundleId: { type: 'string' },
        waitUntilReady: { type: 'boolean' },
      },
    };
  }
  if (bare === 'click') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        on: { type: 'string' },
        coords: { type: 'string' },
        snapshot: { type: 'string' },
        wait_for: { type: 'number' },
        double: { type: 'boolean' },
        right: { type: 'boolean' },
        background: { type: 'boolean' },
        pid: { type: 'number' },
      },
    };
  }
  if (bare === 'type') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' },
        on: { type: 'string' },
        snapshot: { type: 'string' },
        delay: { type: 'number' },
        profile: { type: 'string', enum: ['human', 'linear'] },
        wpm: { type: 'number' },
      },
    };
  }
  if (bare === 'permissions') {
    return { type: 'object', additionalProperties: false, properties: {} };
  }
  return null;
}

function shortString(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) return null;
  return value;
}

function prepareToolCall(policy, toolName, args) {
  const parts = splitToolName(toolName);
  if (!parts || !toolAllowed(policy, toolName)) throw denyTool();
  const input = args === undefined ? {} : args;
  if (!plainObject(input)) throw denyTool();
  const bare = parts.bare;
  if (bare === 'permissions') {
    if (Object.keys(input).length > 0) throw denyTool();
    return { name: `peekaboo__${bare}`, bare, args: {} };
  }
  if (bare === 'image') {
    const next = { format: 'data' };
    if (input.app_target !== undefined) {
      const target = shortString(input.app_target, 200);
      if (!target) throw denyTool();
      next.app_target = target;
    }
    if (input.capture_focus !== undefined) {
      if (!['background', 'auto', 'foreground'].includes(input.capture_focus)) throw denyTool();
      next.capture_focus = input.capture_focus;
    }
    if (input.scale !== undefined) {
      if (!['logical', '1x', 'native', 'retina', '2x'].includes(input.scale)) throw denyTool();
      next.scale = input.scale;
    }
    if (input.retina !== undefined) {
      if (typeof input.retina !== 'boolean') throw denyTool();
      next.retina = input.retina;
    }
    for (const key of Object.keys(input)) {
      if (!['format', 'app_target', 'capture_focus', 'scale', 'retina'].includes(key)) throw denyTool();
    }
    if (input.format !== undefined && input.format !== 'data') throw denyTool();
    return { name: `peekaboo__${bare}`, bare, args: next };
  }
  if (bare === 'app') {
    if (input.action !== 'launch') throw denyTool();
    const name = input.name === undefined ? null : shortString(input.name, 200);
    const bundleId = input.bundleId === undefined ? null : shortString(input.bundleId, 200);
    if (input.name !== undefined && !name) throw denyTool();
    if (input.bundleId !== undefined && !bundleId) throw denyTool();
    if (!name && !bundleId) throw denyTool();
    if ((name && blockedAppTarget(name)) || (bundleId && blockedAppTarget(bundleId))) throw denyTool();
    if (input.waitUntilReady !== undefined && typeof input.waitUntilReady !== 'boolean') throw denyTool();
    for (const key of Object.keys(input)) {
      if (!['action', 'name', 'bundleId', 'waitUntilReady'].includes(key)) throw denyTool();
    }
    const next = { action: 'launch' };
    if (name) next.name = name;
    if (bundleId) next.bundleId = bundleId;
    if (input.waitUntilReady !== undefined) next.waitUntilReady = input.waitUntilReady;
    return { name: `peekaboo__${bare}`, bare, args: next };
  }
  if (bare === 'click') {
    const next = {};
    if (input.query !== undefined) next.query = shortString(input.query, 200);
    if (input.on !== undefined) next.on = shortString(input.on, 32);
    if (input.coords !== undefined) next.coords = shortString(input.coords, 32);
    if (input.snapshot !== undefined) next.snapshot = shortString(input.snapshot, 80);
    if (input.query !== undefined && !next.query) throw denyTool();
    if (input.on !== undefined && !next.on) throw denyTool();
    if (input.coords !== undefined && (!next.coords || !/^[0-9]+(?:\.[0-9]+)?,[0-9]+(?:\.[0-9]+)?$/.test(next.coords))) {
      throw denyTool();
    }
    if (input.snapshot !== undefined && !next.snapshot) throw denyTool();
    if (!next.query && !next.on && !next.coords) throw denyTool();
    if (input.wait_for !== undefined) {
      if (typeof input.wait_for !== 'number' || input.wait_for < 0 || input.wait_for > 10000) throw denyTool();
      next.wait_for = input.wait_for;
    }
    for (const key of ['double', 'right', 'background']) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') throw denyTool();
        next[key] = input[key];
      }
    }
    if (input.pid !== undefined) {
      if (!Number.isInteger(input.pid) || input.pid <= 0) throw denyTool();
      next.pid = input.pid;
    }
    for (const key of Object.keys(input)) {
      if (!['query', 'on', 'coords', 'snapshot', 'wait_for', 'double', 'right', 'background', 'pid'].includes(key)) {
        throw denyTool();
      }
    }
    return { name: `peekaboo__${bare}`, bare, args: next };
  }
  if (bare === 'type') {
    const text = shortString(input.text, 4000);
    if (!text || /[{}]/.test(text)) throw denyTool();
    const next = { text };
    if (input.on !== undefined) {
      next.on = shortString(input.on, 32);
      if (!next.on) throw denyTool();
    }
    if (input.snapshot !== undefined) {
      next.snapshot = shortString(input.snapshot, 80);
      if (!next.snapshot) throw denyTool();
    }
    if (input.delay !== undefined) {
      if (typeof input.delay !== 'number' || input.delay < 0 || input.delay > 1000) throw denyTool();
      next.delay = input.delay;
    }
    if (input.profile !== undefined) {
      if (!['human', 'linear'].includes(input.profile)) throw denyTool();
      next.profile = input.profile;
    }
    if (input.wpm !== undefined) {
      if (typeof input.wpm !== 'number' || input.wpm < 80 || input.wpm > 220) throw denyTool();
      next.wpm = input.wpm;
    }
    for (const key of Object.keys(input)) {
      if (!['text', 'on', 'snapshot', 'delay', 'profile', 'wpm'].includes(key)) throw denyTool();
    }
    return { name: `peekaboo__${bare}`, bare, args: next };
  }
  throw denyTool();
}

function presentToolResult(bare, result) {
  if (bare !== 'image' || !result || !Array.isArray(result.content)) return result;
  const content = [];
  for (const item of result.content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'image' && typeof item.data === 'string' && item.data.length > 0 && item.data.length < 8_000_000) {
      content.push({
        type: 'image',
        data: item.data,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'image/png',
      });
      continue;
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      const dataUrl = item.text.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (dataUrl) {
        content.push({
          type: 'image',
          data: dataUrl[2].replace(/\s/g, ''),
          mimeType: dataUrl[1].toLowerCase(),
        });
        continue;
      }
      const compact = item.text.replace(/\s/g, '');
      if (compact.length > 256 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
        content.push({ type: 'image', data: compact, mimeType: 'image/png' });
        continue;
      }
      if (/^\/\S+$/.test(item.text.trim())) {
        content.push({ type: 'text', text: 'Screenshot captured.' });
        continue;
      }
      content.push({ type: 'text', text: item.text.slice(0, 300) });
    }
  }
  return { ...result, content };
}

function peekabooSpawnPlan(policy) {
  if (!policy.peekaboo.enabled || policy.peekaboo.tools.length === 0) return null;
  const allowed = new Set(policy.peekaboo.tools);
  const disable = [];
  for (const name of PEEKABOO_CATALOG) {
    if (!allowed.has(name)) disable.push(name);
  }
  return {
    command: policy.peekaboo.command,
    args: policy.peekaboo.args.slice(),
    env: {
      PEEKABOO_ALLOW_TOOLS: policy.peekaboo.tools.join(','),
      PEEKABOO_DISABLE_TOOLS: disable.join(','),
    },
    stripEnv: ['BRAVE_SEARCH_API_KEY', 'OSAURUS_ACCESS_KEY', 'BRAVE_API_KEY'],
  };
}

module.exports = {
  POLICY_VERSION,
  DEFAULT_CAPABILITY,
  PEEKABOO_MINIMAL,
  PEEKABOO_GUI,
  PEEKABOO_SENSITIVE,
  PEEKABOO_MUTATING,
  PolicyError,
  classifyPeekabooTool,
  assertLoopbackHost,
  defaultPolicy,
  normalizePolicy,
  loadPolicyFile,
  checkHost,
  checkOrigin,
  checkIdentity,
  decodeRfc2047,
  routeClass,
  authorizeHttp,
  toolAllowed,
  narrowedInputSchema,
  prepareToolCall,
  presentToolResult,
  peekabooSpawnPlan,
};
