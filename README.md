# OllamaChat MCP bridge (hardened)

Loopback HTTP bridge for the [OllamaChat MCP guide](https://sg1-labs.us/ollamachat/mcp/). The iPhone app sends a base URL and calls `GET /health`, `GET /tools`, and `POST /call`. This fork also keeps the existing SSE (`/sse`, `/messages`) and Streamable HTTP (`/mcp`) transports. Every one of those paths uses the same gate.

The process binds to **127.0.0.1** only. One private Tailscale Serve port is the remote path for both the Ollama API and the MCP bridge. The app has URL fields and is not assumed to send a bearer token. Serve adds identity headers. An empty allowlist denies every caller. `ollamaProxy` defaults to false and, when enabled, dials only `127.0.0.1:11434`.

This is not a claim that a passing test suite makes a Mac deployment safe. Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) before enabling any Peekaboo tool.

## Layout

- `server.js` — HTTP, SSE, and Streamable HTTP
- `security-policy.js` — bind, identity, and tool policy
- `bridge-policy.example.json` — fail-closed placeholders, no personal hosts or logins
- `docs/INSTALL.md` — install, Serve, cleanup
- `docs/OLLAMACHAT-CLIENT.md` — what the public iOS guide says, and what is still untested
- `docs/PEEKABOO-ALLOWLIST.md` — Peekaboo 4.9.7 tool review
- `docs/THREAT-MODEL.md` — what the gate does and what it does not

`mcp-config.json` server maps are not started. `POST /config` and `/custom-tools` do not write anything.

## Develop

```bash
npm ci
npm test
node server.js
```

`npm test` runs the files in `test/` and exits non-zero when that count is 0. Those files are part of the release archive. There is no test-only npm dependency.

With no `bridge-policy.json`, the process still listens on `127.0.0.1:3100` and denies every request.
