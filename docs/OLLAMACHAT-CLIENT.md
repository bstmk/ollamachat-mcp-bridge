# OllamaChat client protocol

The iPhone app was not connected to this bridge. The notes below are from public SG1 pages, not from a capture of the app.

## What the public guide says

The setup guide at `https://sg1-labs.us/ollamachat/mcp/` describes Settings → MCP Bridge as a URL field:

- LAN example: `http://192.168.1.42:3100`
- Test Connection, then Refresh Tools
- A tool call is `POST {base}/call` with JSON `{ "name", "arguments" }`
- The bridge base is also used for `GET /health` and `GET /tools`

The same guide's Tailscale section is a different deployment: nginx on port 443, `Access-Control-Allow-Origin: *`, and the bridge mounted at `/mcp/` so the app URL is `https://<magicdns>/mcp`. That shares a port with the existing Funnel listener on 443. This package does not do that. With Serve on port 38443 the base URL is `https://<magicdns>:38443`, and the app would append `/health`, `/tools`, and `/call` if it follows the LAN example rather than the nginx path prefix.

The guide also says iOS blocks plain HTTP to non-local addresses, including Tailscale `100.x` addresses. The phone needs the HTTPS Serve URL. The bridge itself speaks HTTP only on `127.0.0.1`.

The App Store listing for OllamaChat AI (SG1 Labs) describes MCP tool calling as a Pro feature and server setup as URLs. The privacy policy says the app does not call a bridge until an in-app "Allow External Connections" choice is on, and that SG1 does not receive the traffic. No public source for the Swift client was found. A different project, `DenceAtom/ollama-chat-ios`, is not this app.

The guide shows a Brave Search key saved through `POST /config` or the app's settings. This bridge returns 403 for `/config`. If the shipping app still posts that key, the post is refused and the key is not stored. Web search is not on the Peekaboo allowlist.

## What this bridge will accept from that client

If the app is a normal URLSession client:

- It does not send `Authorization`. The gate does not look for one.
- It does not send `Origin`. A missing Origin is allowed. A WebView that sends `Origin: null` or another origin is denied.
- Through Serve, `Host` is the MagicDNS name and port. That hostname must be in `allowedHosts` or the request is `forbidden_host`.
- Serve, not the app, adds `Tailscale-User-Login` and `Tailscale-App-Capabilities`. The app cannot satisfy the gate by itself on a raw tailnet IP.
- Tool names it should send are the names from `GET /tools`, currently `peekaboo__permissions` when that is the only allowlisted tool.

SSE (`/sse`, `/messages`) and Streamable HTTP (`/mcp`) stay available for other MCP clients. The SG1 guide does not say the iPhone app uses them.

## Still unknown because the app was not captured

- Which path Test Connection requests, and whether it requires HTTP 200 with `"status": "ok"`.
- Whether Refresh Tools uses `GET /tools` or `GET /tools/openai`.
- Whether the URL field accepts `:38443` or only port 443.
- Whether a configured URL that already ends in `/mcp` would request `/mcp/call` and miss the route.
- Whether the app sends any header this gate treats as `Origin`.
- How it displays a 403 compared with a tool result whose `isError` is true.
- Whether "Allow External Connections" blocks the request on the phone before Serve sees it.

The Mac loopback checks used injected identity headers and the placeholder login `local-test@example.invalid`. They do not answer this list.
