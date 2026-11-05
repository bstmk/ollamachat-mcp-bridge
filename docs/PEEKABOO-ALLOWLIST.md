# Peekaboo 4.9.7 tool allowlist

The installed CLI on the Mac is `/opt/homebrew/bin/peekaboo`, invoked only as `peekaboo mcp`. This review uses upstream Peekaboo MCP docs and the tool catalog around 4.9.6–4.9.7 (package reports 4.9.7). **Peekaboo was not run here.** Names can differ on the Studio. Any name that is not in this file is denied, including new tools a later release adds.

The bridge fails closed in three places:

1. `peekaboo.tools` must list the tool or it is not advertised and not dispatched.
2. A sensitive or mutating name is rejected at policy load unless that class is explicitly enabled.
3. When a process is spawned, `PEEKABOO_ALLOW_TOOLS` is set to that same list and `PEEKABOO_DISABLE_TOOLS` lists every other catalog name. An empty Peekaboo allow list does **not** fail closed inside Peekaboo itself (an empty filter exposes the registry). This bridge does not spawn Peekaboo when `tools` is empty, and it does not trust the child filter alone.

`gemma4:12b` can call tools and is unreliable at Mac GUI work. OllamaChat can run a tool call without a second confirmation in this bridge. The safe default is an empty list. The smallest opt-in that does not read the screen or move the pointer is **`permissions`**.

## Approved GUI controls

These four are allowed only when `allowGuiControls` is true and each name is listed. `allowMutatingTools` stays false, so `shell` and the other mutating names stay refused.

| Tool | Allowed use | Refused |
| --- | --- | --- |
| `image` | Inline screenshot (`format` forced to `data`) | Saving to a path, and `question` (that sends the image to another model) |
| `app` | `action: "launch"` of an ordinary app | quit, relaunch, hide, switch, force, and Terminal, iTerm, Script Editor, Automator, Shortcuts |
| `click` | One click by element id, query, or coordinates | This can still activate a Delete or Send control in the app that is open |
| `type` | Literal text | `{return}`, delete, tab, escape, and the clear/return flags |

`permissions` stays available. Typing does not know which app is in front. If Terminal is already the focused app, typed characters go there. Launching Terminal by name is refused; that is not a guarantee about an already-open Terminal.

## Minimal

| Tool | What it does | Why it is the only default recommendation |
| --- | --- | --- |
| `permissions` | Reports whether Screen Recording, Accessibility, and related TCC checks are granted | No screenshot, no pointer, no keystrokes. It still reveals that those permissions exist. |

## Sensitive observation

Off unless `allowSensitiveObservation` is true. These do not click, but they disclose the session. A prompt can ask for them and the result returns to the phone and the model.

| Tool | Risk |
| --- | --- |
| `list` | Running apps and window titles |
| `inspect_ui` | Accessibility tree, including on-screen text |
| `see` | Screenshot plus element ids. This is the usual prelude to a later click |
| `image` | Screenshot |
| `verify_state` | Reads UI state after an action |
| `sleep` | Waits. No GUI change, and not useful by itself |

## Mutating, exfiltrating, or full GUI control

Off unless `allowMutatingTools` is true, and still only if each name is listed. Enabling these gives the model the logged-in Mac user's hands. That includes sending messages, changing settings, and driving whatever is on screen. Do not enable them because a model failed a GUI task.

`click`, `type`, `set_value`, `select_text`, `action`, `scroll`, `press`, `hotkey`, `swipe`, `drag`, `move`, `app`, `window`, `menu`, `menu_click`, `dock`, `dialog`, `space`, `clipboard`, `paste`, `browser`, `capture`, `agent`, `analyze`, `shell`.

`analyze` can send an image to a model provider. `agent` hands a task to another agent. `clipboard` can read secrets. `shell` is not part of a safe GUI catalog.

## Not Peekaboo, and never dispatched

Custom shell tools, `builtin__*` helpers, and Osaurus proxy tools are not on this allowlist. HTTP `POST /custom-tools` cannot add one. A command string in `custom-tools.json` is not executed.

## Operator checks this bridge cannot do

On the Mac, after you set `tools` and before you point the phone at the bridge:

```bash
PEEKABOO_ALLOW_TOOLS=permissions /opt/homebrew/bin/peekaboo tools
```

Compare that output to `GET /tools` through the Serve URL. If Peekaboo prints tools the bridge did not list, do not widen the bridge list to match it. Keep the bridge list smaller.
