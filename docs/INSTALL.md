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
shasum -a 256 -c ollamachat-mcp-bridge-2.0.4.tar.gz.sha256
tar -xzf ollamachat-mcp-bridge-2.0.4.tar.gz
cd ollamachat-mcp-bridge-2.0.4
npm ci --omit=dev
npm test
npm audit --omit=dev --audit-level=high
```

`npm test` checks behavior. `npm audit --omit=dev --audit-level=high` checks the installed production tree and exits non-zero when a critical or high advisory is still present. A passing test run is not that audit.

`npm test` runs the automated tests that ship inside the archive. It must report a test count greater than 0. A report of 0 tests is a broken archive; `npm test` exits non-zero in that case. The tests use Node's built-in test runner and `express`, which is a runtime dependency. There is no separate test-only npm package and no fixture file to install. `npm ci --omit=dev` is enough. The tests do not launch Peekaboo or join a tailnet.

`node --test` with no arguments also finds `test/*.test.js` once the archive is intact. The 2.0.0 archive omitted that directory, so both commands reported 0 tests and exited 0. Use 2.0.4. Each request writes one `[diag]` log line: method, path with no query string, status, and tool counts or names. It does not write prompts, message text, response bodies, or account headers. There is no remote diagnostics URL.

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
  "ollamaProxy": true,
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
- `tools` stays `permissions` only. Do not enable screenshots or mutating Peekaboo tools until a later supervised change. See [PEEKABOO-ALLOWLIST.md](PEEKABOO-ALLOWLIST.md).
- `ollamaProxy` defaults to false in `bridge-policy.example.json`. Set it true only in the local file to forward the fixed upstream `127.0.0.1:11434`. There is no URL setting.
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

`--accept-app-caps` exists in Tailscale 1.92 and later. Tailscale 1.104.4 on this Mac includes it. This repository did not run Serve.

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

## 4. Review the tailnet policy before any grant

The live tailnet policy is unchanged. Do not append this snippet and do not replace the policy until you have a screenshot of the current grants and ACLs and you add the change yourself. Grants are a union: a new rule does not remove a broader one. Read every `src` that can reach the Mac, every `ip` of `*`, `443`, `8443`, `10000`, `38443`, `18104`, `18100`, or `18084`, and every `app` value. An existing `*` or `autogroup:member` rule still applies after a more specific grant is added.

Access is the Tailscale account, not one phone and not a tag. Every device signed into that account presents the same `Tailscale-User-Login`. That is the scope that was approved. Do not add `tagOwners` and do not tag the Mac or the phone. Tagging would change device identity for the existing Funnel rules.

Do not use the phone's Tailscale IP as `src`. [tailscale/tailscale#15097](https://github.com/tailscale/tailscale/issues/15097) is still open, and this tailnet was not tested. The grant reference's user selector is the account. `operator@example.com` below is a placeholder. The real login stays in the local `bridge-policy.json` `allowedLogins` and, when you edit policy, in `src`. It is not committed.

```json
{
  "hosts": {
    "ollamachat-mac": "100.64.0.3"
  },
  "grants": [
    {
      "src": ["operator@example.com"],
      "dst": ["ollamachat-mac"],
      "ip": ["tcp:38443"],
      "app": {
        "example.com/cap/ollamachat-bridge": [
          { "role": "caller" }
        ]
      }
    }
  ]
}
```

`100.64.0.3` is a documentation address, not this Mac. `dst` is the bare name from `hosts`, which is the form in the [grants reference](https://tailscale.com/docs/reference/syntax/grants). `src` is one user, so it includes every device signed into that account and no other account. Tailscale 1.104.4 can send the capability header. Serve is still not configured.

## 5. Start the bridge and check denials

```bash
node server.js
```

From the Mac, with no identity headers:

```bash
curl -sS -D - http://127.0.0.1:3100/health -o /tmp/bridge-health.txt
```

Expect HTTP 403 and `forbidden_identity`. Expect no `Access-Control-Allow-Origin` header.

A device signed into a different Tailscale account should not receive the capability. If it can open the URL, the existing policy is broader than the snippet above.

The iPhone app has not been run against this bridge. Assumptions are in [OLLAMACHAT-CLIENT.md](OLLAMACHAT-CLIENT.md). Both settings use the same origin, with no path prefix and no bearer token:

- Ollama URL: `https://<magicdns-name>:38443`
- MCP Bridge URL: `https://<magicdns-name>:38443`

Ollama on the Mac stays at `127.0.0.1:11434`. The phone does not get a second port. iOS needs HTTPS for a Tailscale address. The bridge listens only on loopback, and Serve is the only forward. With `ollamaProxy` true, the phone's model calls use `/api/tags`, `/api/version`, `/api/show`, `/api/chat`, and `/api/generate`. MCP calls use `/health`, `/tools`, and `/call`.

`GET /tools` should list only `peekaboo__permissions`. Do not enable screenshot or mutating Peekaboo tools until a later supervised change. `gemma4:12b` can emit tool calls and is unreliable at Mac GUI tasks.

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
rm -rf /path/to/ollamachat-mcp-bridge-2.0.4
```

That does not remove Peekaboo, Ollama, Tailscale, or Screen Recording permission. Those were not installed by this package.
