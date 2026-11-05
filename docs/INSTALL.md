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
shasum -a 256 -c ollamachat-mcp-bridge-2.0.1.tar.gz.sha256
tar -xzf ollamachat-mcp-bridge-2.0.1.tar.gz
cd ollamachat-mcp-bridge-2.0.1
npm ci --omit=dev
npm test
```

`npm test` runs the automated tests that ship inside the archive. It must report a test count greater than 0. A report of 0 tests is a broken archive; `npm test` exits non-zero in that case. The tests use Node's built-in test runner and `express`, which is a runtime dependency. There is no separate test-only npm package and no fixture file to install. `npm ci --omit=dev` is enough. The tests do not launch Peekaboo or join a tailnet.

`node --test` with no arguments also finds `test/*.test.js` once the archive is intact. The 2.0.0 archive omitted that directory, so both commands reported 0 tests and exited 0. Use 2.0.1.

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

Do not append a grant and do not replace the live policy. Grants and ACLs are a union: a narrower rule does not remove a broader one. Read the current policy in the admin console first. Look for every `src` that can reach the Mac, every `ip` of `*`, `443`, `8443`, `10000`, `38443`, `18104`, `18100`, or `18084`, and every `app` value. Anything that already grants this capability, or that grants network access to the Mac for a user, group, `autogroup:member`, or `*`, still applies after you add a phone rule.

`Tailscale-User-Login` is the user. Every device that user owns presents the same login. Serve does not send a node id. A user, group, `autogroup:self`, or `*` in `src` is not one phone.

An IP address or host alias in `src` is not a verified per-phone control. Tailscale's grant reference allows those selectors, and [tailscale/tailscale#15097](https://github.com/tailscale/tailscale/issues/15097) is still open: reporters find that IP and host-alias sources do not match, including for grants. This tailnet was not tested. Do not put the phone's Tailscale IP in `src` and treat the capability as device-limited.

The selector the grant syntax actually uses for one device identity is a tag. Tag only the phone. Do not tag the Mac. A tag replaces that device's user identity for every existing grant, which can drop the Studio out of rules that still protect Funnel and the other listeners.

This is a review snippet, with placeholders, in the shape from the [grants reference](https://tailscale.com/docs/reference/syntax/grants) (source tag, destination host alias, `ip` and `app` together). It is not an instruction to save it.

```json
{
  "tagOwners": {
    "tag:ollamachat-phone": ["autogroup:admin"]
  },
  "hosts": {
    "ollamachat-mac": "100.64.0.3"
  },
  "grants": [
    {
      "src": ["tag:ollamachat-phone"],
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

`100.64.0.3` is a documentation address in the Tailscale CGNAT range, not this Mac. `ollamachat-mac` is the bare name from `hosts`, which is the grant reference's host-alias form. `tag:ollamachat-phone` matches only devices that carry that tag.

A tagged phone does not receive `Tailscale-User-Login`. The local bridge policy for that setup is:

```json
"identityMode": "tagged",
"allowedLogins": []
```

Tagged mode allows a request only when the login header is absent, the Funnel header is absent, and the capability array is present. An untagged laptop still gets a login header from Serve, so it stays denied even if some other grant also hands it the capability. Tagging is an ACL change you make yourself. No tag was applied from this package.

Until that review is done, leave Serve unconfigured. Tailscale 1.104.4 can send the capability header; the phone grant is not in place.

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

The iPhone app has not been run against this bridge. What the public guide says it sends, and what is still unknown, is in [OLLAMACHAT-CLIENT.md](OLLAMACHAT-CLIENT.md). The LAN example in that guide uses the bridge origin with no path prefix:

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
rm -rf /path/to/ollamachat-mcp-bridge-2.0.1
```

That does not remove Peekaboo, Ollama, Tailscale, or Screen Recording permission. Those were not installed by this package.
