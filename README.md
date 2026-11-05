# OllamaChat MCP bridge (hardened)

Loopback HTTP bridge for the [OllamaChat MCP guide](https://sg1-labs.us/ollamachat/mcp/). The iPhone app sends a base URL and calls `GET /health`, `GET /tools`, and `POST /call`. This fork also keeps the existing SSE (`/sse`, `/messages`) and Streamable HTTP (`/mcp`) transports. Every one of those paths uses the same gate.

The process binds to **127.0.0.1** only. A private Tailscale Serve listener on an unused port is the remote path. The app has URL fields and is not assumed to send a bearer token. Serve adds identity headers. An empty allowlist denies every caller and every tool.

This is not a claim that a passing test suite makes a Mac deployment safe. Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) before enabling any Peekaboo tool.

## Layout

- `server.js` — HTTP, SSE, and Streamable HTTP
- `security-policy.js` — bind, identity, and tool policy
- `bridge-policy.example.json` — fail-closed placeholders, no personal hosts or logins
- `docs/INSTALL.md` — install, Serve, cleanup
- `docs/PEEKABOO-ALLOWLIST.md` — Peekaboo 4.9.7 tool review
- `docs/THREAT-MODEL.md` — what the gate does and what it does not

`mcp-config.json` server maps are not started. `POST /config` and `/custom-tools` do not write anything.

## Develop

```bash
npm ci
npm test
node server.js
```

With no `bridge-policy.json`, the process still listens on `127.0.0.1:3100` and denies every request.
