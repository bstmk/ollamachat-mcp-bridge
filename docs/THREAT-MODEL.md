# Threat model

The bridge turns a chat model into a process on the Mac that can call Peekaboo. The useful property is narrow: an iPhone running OllamaChat can reach a loopback service only through Tailscale Serve, and only a configured tool can be dispatched. Passing the unit tests does not make that deployment safe.

## What was actually wrong

Confirmed in this tree, not taken from a review note:

- `server.js` called `app.listen(PORT, '0.0.0.0')`. Any interface on the Mac could open the port.
- `app.use(cors())` advertised `Access-Control-Allow-Origin: *`.
- `POST /config` and `setBraveKey` / `setOsaurusKey` wrote secrets into `.env` for any caller.
- `POST /custom-tools` stored an arbitrary shell command, and `executeCustomTool` interpolated arguments into that command.
- `GET /tools` published every builtin, custom, and connected MCP tool with no allowlist.
- The same `callTool` path was reachable from `POST /call`, `POST /messages` (SSE), and `POST /mcp` (Streamable HTTP), including JSON-RPC batches.
- SSE built the message endpoint from `X-Forwarded-Host`.

The iOS guide at `https://sg1-labs.us/ollamachat/mcp/` describes a base URL, `GET /health`, `GET /tools`, and `POST /call` with `{name, arguments}`. Its Tailscale section puts nginx on 443, adds `Access-Control-Allow-Origin: *`, and uses a path prefix. The settings it describes are URL fields. This bridge keeps `/health`, `/tools`, `/tools/openai`, `/call`, `/sse`, `/messages`, and `/mcp`. It does not require an `Authorization` header. It does not follow the nginx-on-443 pattern, because 443 is already a Funnel port on this Mac and because a wildcard CORS header is not part of the native app's protocol.

## Assets

- The Mac GUI session and anything Peekaboo can see or type once TCC has allowed it.
- The tool list the model is willing to call without a person confirming each call.
- Tailscale identity of the phone, as distinct from every other device on the tailnet.
- Existing Funnel listeners (443→18104, 10000→18100, 8443→18084). This design does not reconfigure them.

## Trust boundary

```text
iPhone OllamaChat
  |  HTTPS URL only, no bearer token
  v
tailscaled on the Mac (Serve, port 38443, not Funnel)
  |  strips and resets Tailscale-* headers, then connects to 127.0.0.1
  v
bridge on 127.0.0.1:3100
  |  allowlisted stdio JSON-RPC only
  v
/opt/homebrew/bin/peekaboo mcp
```

Anyone who can put a request on a non-loopback interface is outside the trust boundary and should not reach the process at all. A process already running as the same user on the Mac is inside the machine and can open `127.0.0.1`.

## Controls

- Bind address must be `127.0.0.1` or `::1`. `0.0.0.0`, `::`, and LAN addresses throw before `listen`.
- `Host` must be localhost, `127.0.0.1`, `::1`, or a name listed in `allowedHosts`. The port is ignored so `name.ts.net:38443` matches `name.ts.net`.
- A present `Origin` is denied unless it is an exact configured origin. The default list is empty. `null` and `*` are denied. Missing `Origin` is allowed because the native app does not send one.
- No CORS response headers are set.
- `Tailscale-Funnel-Request` denies the request. Funnel does not fill user identity.
- `identityMode: "user"` requires `Tailscale-User-Login` to be an exact allowlist entry and `Tailscale-App-Capabilities` to contain `requiredAppCapability` as an array. An empty allowlist matches nobody.
- `identityMode: "tagged"` allows only a missing login header plus that capability. Use it when the phone is tagged. Do not combine it with a login allowlist.
- Login comparison decodes a single RFC 2047 word and then requires an exact lowercased match. The header value is not copied into the denial body.
- `/config` and `/custom-tools`, every method, return 403 after the gate. JSON-RPC methods other than `initialize`, `ping`, `notifications/*`, `tools/list`, and `tools/call` are not dispatched.
- Tool dispatch requires the name `peekaboo__<catalog name>` and that bare name in `peekaboo.tools`. Custom tools, builtins, and unknown names never call a child.
- Peekaboo is spawned only from the policy: basename `peekaboo`, absolute path, args exactly `["mcp"]`. Server entries in `mcp-config.json` are ignored.
- Sensitive and mutating catalog names refuse to load unless the matching boolean is true.

## Identity is not a device id

Serve's documented identity headers are `Tailscale-User-Login`, `Tailscale-User-Name`, and `Tailscale-User-Profile-Pic`. The source clears those names, then sets them from the tailnet user. It does not set a node name. Two devices owned by the same user produce the same login. A laptop and the iPhone are the same caller unless the **capability grant's `src`** is only the phone.

That grant has to be one device: a Tailscale IP or a host alias, or a tag that is on that phone alone. `src` of the user, a group, or `autogroup:member` authorizes every device that selector covers. Grants are additive, so one wide grant undoes a narrow one. Tagged nodes do not get the login header; the capability header can still be set for them.

App capabilities need Tailscale 1.92+ and `--accept-app-caps` on the Serve command. Without that flag the header is missing and the bridge denies the call.

## Residual risks

These remain true if every test in this repo passes.

1. **Local spoofing.** Any process on the Mac can connect to `127.0.0.1:3100` and send `Tailscale-User-Login` and `Tailscale-App-Capabilities`. Serve overwrites those headers only for connections it proxies. The bridge cannot tell Serve from another local client. Malware, a local SSRF bug, or a second reverse proxy on the Mac can impersonate the phone. Do not put nginx, Caddy, or the existing Funnel in front of this port.
2. **Prompt injection and automatic tool use.** The model decides when to call a tool. Text on screen, a web page, or a chat message can instruct it. This bridge has no per-call approval. Whatever is in `peekaboo.tools` is available to that model. `gemma4:12b` is assumed able to emit tool calls and unreliable at GUI tasks. A bad call is still a real click if you enabled `click`.
3. **Observation is disclosure.** `see`, `image`, and `inspect_ui` send the desktop to the phone and the model. `permissions` reveals which TCC prompts have been accepted. None of that is "read-only" in the sense of harmless.
4. **Mutating tools are the user.** Click, type, menus, paste, and `agent` run as the GUI user. Peekaboo's own hardening does not put a second person in the loop for this HTTP bridge.
5. **Peekaboo was not executed here.** The catalog may not match `/opt/homebrew/bin/peekaboo` 4.9.7 on the Studio. The child may ignore `PEEKABOO_ALLOW_TOOLS`. The bridge still refuses names it did not allow, but a tool it did allow is really invoked, and this environment never watched that happen. Screen Recording and Accessibility prompts are outside this process.
6. **The child inherits the parent environment**, minus `BRAVE_SEARCH_API_KEY`, `OSAURUS_ACCESS_KEY`, and `BRAVE_API_KEY`. Other variables in the Node process are visible to Peekaboo. That was not tested on macOS.
7. **Tailscale ACL behavior was not tested.** IP or host-alias `src` may fail to match on some tailnets. A failed match fails closed only if you do not widen the grant. This repo did not apply a policy or open a tailnet.
8. **Shared nodes and shares.** A node you share can reach Serve if the ACL allows it. Identity headers are filled for that visitor. They pass only if their login is listed and the capability grant includes them. Do not list them.
9. **Funnel on the same port replaces Serve.** The last command for a port wins, and Funnel is public. Funnel traffic has no user identity. The bridge denies a request that still carries `Tailscale-Funnel-Request`, but the right control is to never publish 38443 with Funnel and never reuse 443, 8443, or 10000.
10. **Host allowlisting is not TLS.** TLS ends at tailscaled. A wrong `allowedHosts` entry of your real MagicDNS name is required for the phone, and an extra name you add is accepted from any local client that passed the identity check.
11. **The previous public git history** still contains older personal paths and the old unauthenticated routes. This change removes them from the tree. It does not rewrite history.
12. **Ollama is a separate service.** A model that can be prompted can ask the app to call the bridge. Binding Ollama to `0.0.0.0` is out of scope and `start-all.sh` no longer does that. The existing Funnel in front of other local ports is unchanged by these files and is not reviewed here.

## Rejected clients

| Client | Result |
| --- | --- |
| LAN or public client hitting the Mac's IP | No listener. The socket is loopback. |
| Tailnet client bypassing Serve and hitting a published bridge port | There is no published bridge port. Serve is the only forward. |
| Funnel request, including one with forged login headers | `forbidden_funnel` when the Funnel header is present. Missing capability or login also denies. |
| Same user, other device, grant `src` is only the phone | Serve does not attach the capability. `forbidden_identity`. |
| Same user, grant `src` is the user | **Allowed.** That is not per-device. Do not write that grant. |
| Tagged phone, `identityMode` still `user` | Login header is absent. Denied. |
| Untagged device, `identityMode` `tagged` | Login header is present. Denied. |
| Request with `Origin` or a foreign `Host` | `forbidden_origin` or `forbidden_host`, including when the identity headers are otherwise valid. |
| `POST /config`, `/custom-tools`, or a JSON-RPC config method | 403 or method-not-found. No `.env` write and no shell. |
| Tool name not on the allowlist | Not dispatched. |

## Out of scope

End-to-end iPhone → Serve → Peekaboo → GUI was not run. Ollama 0.40.13, the M5 Max, and `gemma4:12b` were not present in the build environment. No tailnet, ACL, or Funnel command was executed.
