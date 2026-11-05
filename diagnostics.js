'use strict';

/**
 * Request metadata for the local operator log.
 * Counts and tool names only. No query string, body, prompt, or account header.
 */

const recent = [];
const MAX_RECENT = 200;

function safeToken(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
}

function requestPath(req) {
  const raw = String((req && req.path) || '/').split('?')[0];
  if (raw.length > 1 && raw.endsWith('/')) return raw.slice(0, -1);
  return raw || '/';
}

function toolNamesFromList(tools) {
  if (!Array.isArray(tools)) return [];
  const names = [];
  for (const tool of tools) {
    const name = safeToken(tool && (tool.function?.name || tool.name));
    if (name) names.push(name);
  }
  return names;
}

function chatRequestTools(body) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || ''));
  } catch (_) {
    return { request_tools: 'unparsed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { request_tools: 'unparsed' };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'tools')) {
    return { request_tools: 'absent' };
  }
  if (!Array.isArray(parsed.tools)) return { request_tools: 'invalid' };
  const names = toolNamesFromList(parsed.tools);
  return { request_tools: parsed.tools.length, request_tool_names: names };
}

function ndjsonToolCalls() {
  let pending = '';
  const names = [];
  const collect = (calls) => {
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      const name = safeToken(call && (call.function?.name || call.name));
      if (name) names.push(name);
    }
  };
  const takeLine = (line) => {
    let payload = String(line || '').trim();
    if (payload.startsWith('data:')) payload = payload.slice(5).trim();
    if (!payload || payload === '[DONE]' || !payload.includes('tool_calls')) return;
    let obj;
    try { obj = JSON.parse(payload); } catch (_) { return; }
    collect(obj && obj.message && obj.message.tool_calls);
    collect(obj && obj.tool_calls);
    if (obj && Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        collect(choice && choice.delta && choice.delta.tool_calls);
        collect(choice && choice.message && choice.message.tool_calls);
      }
    }
  };
  return {
    push(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (pending.length > 1024 * 1024) pending = pending.slice(-64 * 1024);
      let index = pending.indexOf('\n');
      while (index >= 0) {
        takeLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    },
    finish() {
      if (pending.trim()) takeLine(pending.trim());
      pending = '';
      return { response_tool_calls: names.length, response_tool_names: names.slice() };
    },
  };
}

function format(entry) {
  const method = safeToken(entry.method).toUpperCase() || 'UNKNOWN';
  const path = requestPath({ path: entry.path });
  const status = Number.isInteger(entry.status) ? String(entry.status) : '0';
  const parts = [`[diag] ${method} ${path} ${status}`];
  if (entry.tools !== undefined) parts.push(`tools=${entry.tools}`);
  if (Array.isArray(entry.tool_names) && entry.tool_names.length) {
    parts.push(`names=${entry.tool_names.map(safeToken).filter(Boolean).join(',')}`);
  }
  if (entry.tool) parts.push(`tool=${safeToken(entry.tool)}`);
  if (entry.request_tools !== undefined) parts.push(`request_tools=${safeToken(entry.request_tools)}`);
  if (Array.isArray(entry.request_tool_names) && entry.request_tool_names.length) {
    parts.push(`request_tool_names=${entry.request_tool_names.map(safeToken).filter(Boolean).join(',')}`);
  }
  if (entry.response_tool_calls !== undefined) parts.push(`response_tool_calls=${entry.response_tool_calls}`);
  if (Array.isArray(entry.response_tool_names) && entry.response_tool_names.length) {
    parts.push(`response_tool_names=${entry.response_tool_names.map(safeToken).filter(Boolean).join(',')}`);
  }
  return parts.join(' ');
}

function record(entry) {
  const line = format(entry);
  recent.push(line);
  if (recent.length > MAX_RECENT) recent.shift();
  return line;
}

function snapshot() {
  return recent.slice();
}

function reset() {
  recent.length = 0;
}

module.exports = {
  safeToken,
  requestPath,
  chatRequestTools,
  ndjsonToolCalls,
  format,
  record,
  snapshot,
  reset,
};
