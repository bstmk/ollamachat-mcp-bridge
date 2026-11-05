# Install on the Mac Studio

This package does not install a login item, LaunchAgent, or LaunchDaemon. It does not change Tailscale ACLs, and it does not talk to the existing Funnel listeners. You run the commands below yourself after checking them.

The bridge was not executed against Peekaboo, Ollama, or the iPhone app in the environment that built it. Treat the steps as a procedure to verify, not as a completed deployment.

## What you are installing

- Node bridge on `127.0.0.1:3100` (loopback only).
- A **new private** Tailscale Serve HTTPS port **38443** forwarding to that loopback port.
- Identity taken from headers Serve sets. The OllamaChat URL is only the HTTPS base URL.

Do **not** run `tailscale serve 3100`. That publishes HTTPS **443**, which is already a Funnel port on this Mac. Do **not** run `tailscale serve reset`, `tailscale serve off` with no port, or `tailscale funnel` against 443, 10000, or 8443.

Leave these Funnel mappings untouched:

| Funnel port | Existing local target |
| --- | --- |
| 443 | 18104 |
| 10000 | 18100 |
| 8443 | 18084 |

38443 is not one of those ports. `18104`, `18100`, and `18084` are not the bridge.

## 1. Verify the archive

On the Mac, outside any git checkout:

```bash
shasum -a 256 -c ollamachat-mcp-bridge-2.0.0.tar.gz.sha256
tar -xzf ollamachat-mcp-bridge-2.0.0.tar.gz
cd ollamachat-mcp-bridge-2.0.0
npm ci --omit=dev
npm test
```

`npm test` checks the gate with mocks. It does not launch Peekaboo or join a tailnet.

## 2. Write a local policy

```bash
cp bridge-policy.example.json bridge-policy.json
```

`bridge-policy.json` is gitignored. Do not commit it. Replace only the placeholders. The example denies everyone (`allowedLogins` is empty, Peekaboo is disabled).

Recommended first policy, still with placeholders:

```json
{
  "policyVersion": 1,
  "bindHost": "127.0.0.1",
  "port": 3100,
  "allowedHosts": ["127.0.0.1", "localhost", "mac-studio.example.ts.net"],
  "allowedOrigins": [],
  "allowedLogins": ["operator@example.com"],
  "requiredAppCapability": "example.com/cap/ollamachat-bridge",
  "identityMode": "user",
  "allowSensitiveObservation": false,
  "allowMutatingTools": false,
  "peekaboo": {
    "enabled": true,
    "command": "/opt/homebrew/bin/peekaboo",
    "args": ["mcp"],
    "tools": ["permissions"]
  }
}
```

- `allowedHosts` must include the MagicDNS name Serve will put in `Host`, without the port. `mac-studio.example.ts.net` is a placeholder.
- `allowedLogins` is the exact Tailscale login Serve puts in `Tailscale-User-Login` (often `name@github` or an email). It is **not** a device id. Every device that user owns presents the same login.
- `tools` starts at `permissions` only. See [PEEKABOO-ALLOWLIST.md](PEEKABOO-ALLOWLIST.md). Leave `allowSensitiveObservation` and `allowMutatingTools` false until you accept those risks.
- `command` must be the absolute Peekaboo binary. `args` must stay `["mcp"]`.

Confirm the binary you think you are pinning:

```bash
ls -l /opt/homebrew/bin/peekaboo
/opt/homebrew/bin/peekaboo --version
```

This repository was not able to run that binary.

## 3. Record Tailscale state, then add one Serve port

```bash
tailscale version
tailscale serve status
tailscale funnel status
```

Save that output. After the next command, those Funnel lines must be the same.

Serve must be Tailscale **1.92 or newer** so `--accept-app-caps` exists. Older Serve never sends `Tailscale-App-Capabilities`, and the bridge then denies every request.

```bash
tailscale serve --bg \
  --https=38443 \
  --accept-app-caps=example.com/cap/ollamachat-bridge \
  http://127.0.0.1:3100
```

`--bg` stores the Serve config in Tailscale and restores it when tailscaled restarts. It is not a macOS login item. If you omit `--bg`, the proxy stops when that terminal exits.

Use the same capability string as `requiredAppCapability`. `http://127.0.0.1` is the only proxy target Serve documents for a local HTTP backend. Do not point Serve at `0.0.0.0`, a LAN IP, or an existing Funnel port.

Check the result:

```bash
tailscale serve status
tailscale funnel status
```

You want a new private HTTPS 38443 entry and the same Funnel 443 / 10000 / 8443 mappings as before. If any Funnel line changed, stop and restore from the output you saved. Do not improvise with `tailscale serve reset`.

## 4. Restrict the capability to one device

Tailnet membership is not a per-device allowlist. `Tailscale-User-Login` is the user. Serve does not send a node id. The per-device control is the **grant `src`** that decides whether this capability is attached.

Add a grant yourself in the tailnet policy. This repo cannot edit that policy. Do not grant the capability to a user, a group, `autogroup:member`, or `*`. Those selectors cover every matching device, and they all share one login.

Prefer one device, by its Tailscale IP or a host alias:

```json
{
  "hosts": {
    "ollamachat-iphone": "100.64.0.2",
    "ollamachat-mac": "100.64.0.3"
  },
  "grants": [
    {
      "src": ["ollamachat-iphone"],
      "dst": ["ollamachat-mac"],
      "ip": ["tcp:38443"],
      "app": {
        "example.com/cap/ollamachat-bridge": [{ "role": "caller" }]
      }
    }
  ]
}
```

`100.64.0.2` and `100.64.0.3` are placeholders in the Tailscale CGNAT range, not this Mac or this phone. Grants are a union: if any other grant gives the same capability to a wider `src`, that wider grant wins. Search the whole policy for `example.com/cap/ollamachat-bridge` before saving.

There is an open Tailscale report that IP and host-alias `src` selectors sometimes fail to match ([tailscale/tailscale#15097](https://github.com/tailscale/tailscale/issues/15097)). If your iPhone is denied when it should match, do not "fix" it by switching `src` to your user. Use a tag that exists on that one device and set the bridge to tagged mode:

```json
"identityMode": "tagged",
"allowedLogins": []
```

Tagged nodes do not receive `Tailscale-User-Login`. Tagged mode allows a request only when the login header is absent, the Funnel header is absent, and the capability array is present. An untagged laptop still gets a login header from Serve, so it stays denied. Tagging a device is an ACL change you make yourself.

## 5. Start the bridge and check denials

```bash
node server.js
```

From the Mac, with no identity headers:

```bash
curl -sS -D - http://127.0.0.1:3100/health -o /tmp/bridge-health.txt
```

Expect HTTP 403 and `forbidden_identity`. Expect no `Access-Control-Allow-Origin` header.

From another tailnet device that is not the granted phone, open `https://<magicdns>:38443/health`. Expect a Tailscale ACL denial, or HTTP 403 from the bridge if the packet was proxied without the capability. A 200 from that second device means the grant is not limited to one device.

From the phone's browser or a tailnet-aware client, the same URL should return 200 only after the policy login and capability match. Then set OllamaChat:

- Ollama URL: your existing local or tailnet Ollama URL. This package does not change Ollama or the Funnel ports in front of it.
- MCP Bridge URL: `https://<magicdns-name>:38443`

No path prefix and no bearer token. The app appends `/health`, `/tools`, and `/call`. iOS needs HTTPS for a Tailscale address; plain `http://100.x.x.x:3100` is the wrong URL, and the bridge is not listening on the tailnet interface anyway.

`GET /tools` should list at most `peekaboo__permissions` until you edit the policy. OllamaChat refreshes tools from that list and can call them when the model decides to. `gemma4:12b` can emit tool calls and is not a reliable Mac GUI agent. Do not enable click, type, or other mutating tools to compensate for that.

## 6. Cleanup

Stop the Node process you started (Ctrl-C in that terminal). Nothing in this package registered itself to start on login.

Remove only the new Serve port:

```bash
tailscale serve --https=38443 off
tailscale serve status
tailscale funnel status
```

Confirm 443 → 18104, 10000 → 18100, and 8443 → 18084 are still present and unchanged. Do not run `tailscale serve reset`.

Delete the unpacked directory if you do not want the files:

```bash
rm -rf /path/to/ollamachat-mcp-bridge-2.0.0
```

That does not remove Peekaboo, Ollama, Tailscale, or Screen Recording permission. Those were not installed by this package.
