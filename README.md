# Foundry MCP

Lets a coding agent (Claude Code, Codex, or any MCP client that speaks streamable HTTP) read and change a
[Foundry VTT](https://foundryvtt.com) world through the GM's own browser session. It is aimed at people who build
macros, modules and automation and want an agent that can run code in a test world and see what broke.

> **This gives the agent full GM power.** `foundry_eval` runs arbitrary JavaScript as the GM. Read
> [Security](#security) before enabling the module anywhere you care about.

## How it works

```
MCP client(s) ──HTTP POST /mcp──►  hub (Node, 127.0.0.1:30123)  ◄──WebSocket /foundry── Foundry module (GM tab)
```

- **Hub** (`server/`): one long-running Node process bound to loopback. Any number of MCP clients share it.
- **Module** (`foundry-mcp/`): about 250 lines. In a GM's tab it dials the hub, evaluates the JavaScript it is sent,
  and forwards warnings and errors. Foundry has no server-side API, so a logged-in GM tab is required.
- All tool logic lives in the hub, so Foundry or game-system updates rarely need a module change.

### Tools

| Tool | What it does |
|---|---|
| `foundry_status` | World, Foundry version, game system and version, active scene, active modules. |
| `foundry_eval` | Runs the body of an async function as the GM; returns the value, console output during the run, and a `logSeq` cursor. |
| `foundry_logs` | Reads captured warnings and errors, including ones raised after `foundry_eval` returned. |

Nothing is specific to one game system. Agents are told to call `foundry_status` first and not to assume a system
or module.

## Prerequisites

- Foundry VTT 14 (see [Tested versions](#tested-versions)), with GM access to a world you can afford to break.
- Node.js 20 or newer on the same computer as the GM's browser.
- An MCP client that supports streamable HTTP servers.

## Setup

1. **Install the hub.**
   ```
   cd server
   npm install
   ```
2. **Allow a world.** Copy `server/config.example.json` to `server/config.json` and put your *test* world's id in
   `worlds` (the id is the world's folder name under `Data/worlds`). With no worlds listed the hub refuses to run
   any code.
3. **Install the module.** Copy or link the `foundry-mcp` folder into Foundry's `Data/modules` folder, then restart
   Foundry so it sees the new module. On Windows a junction keeps it in sync with this checkout:
   ```
   New-Item -ItemType Junction -Path "<Foundry user data>\Data\modules\foundry-mcp" -Target "<this repo>\foundry-mcp"
   ```
4. **Start the hub** and leave it running: `npm start` in `server`.
5. **Enable the module** in the test world only (Manage Modules ► Foundry MCP) and log in as a GM. The hub prints
   `Foundry connected: world=<id> (allowed)`.
6. **Register the hub with your client.**
   ```
   claude mcp add --transport http --scope user foundry http://127.0.0.1:30123/mcp
   codex mcp add foundry --url http://127.0.0.1:30123/mcp
   ```
   Tools that drive those agents (IDE extensions, orchestrators) see the server only if they launch the agent with
   that same user configuration; check with `foundry_status` rather than assuming.

### Configuration

`server/config.json` (never committed), or the environment variable, which wins:

| Key | Variable | Default | Meaning |
|---|---|---|---|
| `port` | `FOUNDRY_MCP_PORT` | `30123` | Loopback port for both `/mcp` and `/foundry`. |
| `worlds` | `FOUNDRY_MCP_WORLDS` | none | World ids code may run in. `*` allows any world. |
| `origins` | `FOUNDRY_MCP_ORIGINS` | `http://localhost:30000`, `http://127.0.0.1:30000` | Page origins allowed to connect as Foundry. Must match the address in the GM's browser exactly. |
| `token` | `FOUNDRY_MCP_TOKEN` | none | Optional shared secret. When set, MCP clients must send `Authorization: Bearer <token>` and the module's "Hub token" setting must match. |
| `logLimit` | `FOUNDRY_MCP_LOG_LIMIT` | `1000` | Log entries kept in memory. |

Module settings (per browser): hub address (default `ws://127.0.0.1:30123/foundry`; only loopback addresses are
accepted) and the optional hub token.

## Verifying against a real world

`npm test` exercises the hub and the real module script against *stubbed* Foundry globals. It proves the plumbing,
not Foundry. After setup, check a real test world from your agent:

1. `foundry_status` returns your test world's id, system and modules.
2. `foundry_eval` with `return game.actors.size` returns a number.
3. `foundry_eval` with `setTimeout(() => console.error('late probe'), 500); return 1` returns at once; a second or so
   later `foundry_logs` with `since` set to the returned `logSeq` shows the entry with `fromEval: true`.
4. Reload the world (F5). `foundry_status` works again within about five seconds, and `foundry_logs` still shows the
   earlier entries followed by "Foundry disconnected" / "Foundry connected" markers.

## Logs

The module captures, in the GM tab only:

- `console.warn` and `console.error` (most UI notifications also pass through these);
- uncaught exceptions and unhandled promise rejections.

Each entry carries `seq`, `time`, `level`, `source`, `text`, a trimmed `stack`, a repeat `count`, and two attribution
fields derived from the stack:

- `packages`: ids of the modules or systems whose code is on the stack, innermost first.
- `fromEval`: `true` when code sent through `foundry_eval` is on the stack.

These let an agent tell an error it caused or faked from one a module genuinely raised. A line that merely *says*
`midi-qol | ...` but was printed by evaluated code has `fromEval: true` and no `midi-qol` in `packages`; a real
midi-qol workflow failure has `midi-qol` in `packages`. Attribution is a heuristic: a module that logs an error on
behalf of a macro is the one named, and `fromEval` is lost across some asynchronous boundaries (for example a world
macro that a module runs later).

Behaviour worth knowing:

- **Retention.** The hub keeps the newest `logLimit` entries in memory only. They survive world reloads and Foundry
  disconnects and can be read while Foundry is disconnected. They are lost when the hub restarts. Nothing is written
  to disk. `evicted` in every reply says how many entries have fallen off.
- **Start-up and offline errors.** Capture starts when the module script loads, and up to 200 entries are held in the
  tab until the hub accepts the connection.
- **Floods.** Identical consecutive entries collapse into one with a `count`. Beyond 100 entries per second the tab
  drops entries and the next one reports `droppedBefore`.
- **Querying.** Filter by `since`, minimum `level`, `package`, `contains`; `limit` returns the newest matches. The
  buffer is shared by all clients, so prefer `since` cursors. `clear` empties it for everyone.
- **Levels.** Many modules report real failures as warnings (midi-qol logs a failing on-use macro with
  `console.warn`), so do not filter to `error` only.
- **Privacy.** Only warnings and errors are kept, never ordinary `console.log` output. Values that look like
  credentials (`password=`, `api_key:`, bearer tokens, JWTs, long opaque strings) are replaced with `[redacted]`
  before leaving the browser. This is best effort; log text is otherwise whatever your modules print, which can
  include actor, item and user names. Logs from worlds that are not on the allowlist are discarded.
- **Not captured.** `console.log/info/debug`, notifications created with `console: false`, failed network or image
  loads, errors in other users' browsers, and errors thrown while modules are still being imported before this one.

## Security

`foundry_eval` is remote code execution in the GM's browser, on purpose. Anything a GM can do in the Foundry
console, the connected agent can do: edit or delete every document in the world, read every setting (including API
keys other modules store), make network requests from the GM's browser, and affect connected players. An agent can
also be steered by text it reads, so a journal entry or chat message in the world could carry instructions.

What the project does about it:

- The hub listens on `127.0.0.1` only and rejects requests whose `Host` is not loopback (DNS rebinding).
- `/mcp` rejects any request that carries an `Origin` header, so web pages cannot call it.
- `/foundry` accepts WebSocket connections only from the configured page origins, so another web page cannot pose
  as the Foundry tab.
- The module connects only for GM users, only to a loopback address, and only in worlds where it is enabled.
- The hub runs code and keeps logs only for worlds on its allowlist, which is empty by default.
- One GM tab at a time; a tab that vanishes without closing is dropped after a heartbeat so another can connect.
- An optional shared token covers computers with more than one user account.

What remains, and what to do about it:

- **Use a copy of your world.** Enable the module only in a test world, and keep live campaigns off the allowlist.
  The allowlist is enforced by the hub from what the module reports; it is a guard against mistakes, not against a
  hostile module or a tampered hub.
- **Any program running as you can use the hub** and so can act as GM while a world is connected. On a shared
  computer other accounts can reach the port too unless you set a token.
- **The module trusts whatever listens on the hub port.** If the hub is not running, another local program could
  listen there and send code to the tab. The token does not prevent this.
- **The token is stored in plain text** in `config.json`, in your MCP client's configuration and in the browser.
- **Timeouts do not stop code.** A timed-out `foundry_eval` keeps running in the tab.
- **Redaction is best effort**, and `foundry_eval` can read anything regardless.
- Run the hub only while you are working, and disable the module when you are done with a world.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Foundry is not connected" | Hub started after the world loaded (it reconnects within 5 s), the module is not enabled, you are not logged in as GM, or the page origin is not in `origins`. The browser console (F12) shows the failed WebSocket. |
| "World ... is not on this hub's allowlist" | Add the id to `worlds` in `server/config.json` and restart the hub, if you really mean to. |
| "module ... is out of date" | Module and hub versions differ. Update the module folder and reload the world. |
| Hub prints nothing on world load | Foundry is served from another address (reverse proxy, hosting service, different port). Set `origins` to the exact origin in the address bar. |
| A second GM tab never connects | Only one tab is served. Close the other; the new one connects within 30 s. |
| 401 from `/mcp` | A hub token is set; give it to the client as a bearer token. |
| Results end in `[truncated ...]` | Return fewer fields; replies are capped at 80,000 characters. |

## Tested versions

Tested by the author on one Windows 11 machine:

| Component | Version |
|---|---|
| Foundry VTT | 14.370 (desktop app, world served at `http://localhost:30000`) |
| Game system | dnd5e 6.0.6 |
| Automation modules present | midi-qol 14.6.11, DAE 14.6.9, libWrapper 1.13.5.1, and about 50 others |
| Node.js | 24.16 |
| MCP SDK | `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2 |
| Clients | Claude Code, Codex CLI 0.169.0 |

### Tested

- `foundry_status` and `foundry_eval` against a real dnd5e test world from Claude Code and Codex, including
  reading and writing document flags, and automatic reconnection after a world reload.
- `foundry_logs` against the same world: start-up warnings from other modules, an asynchronous error raised after
  `foundry_eval` returned, and a real midi-qol workflow whose on-use macro threw, attributed to `midi-qol`.
- Everything in `npm test` (23 checks, simulated Foundry): tools, serialization, timeouts, log capture, attribution,
  redaction, filters, flood limits, retention, reconnects, origin and token checks, the world allowlist.

### Not tested

- Any game system other than dnd5e. Nothing depends on dnd5e, but no other system has been run.
- Foundry 13 or earlier (the manifest requires 14), macOS, Linux, and browsers other than the desktop app.
- Foundry behind HTTPS, a reverse proxy or a hosting service. Browsers may block a secure page from reaching
  `ws://127.0.0.1`.
- The hub token against real Foundry (simulated only).
- Several GM tabs or several worlds at once.

### Planned, not built

- Installation through a Foundry manifest URL and packaged releases.
- A safer middle tier of read-only tools, so `foundry_eval` can be switched off.
- Persisting logs across hub restarts (deliberately absent for now, for privacy).

## Development

`npm test` in `server` takes about 25 seconds. `PROTOCOL` in `foundry-mcp/scripts/bridge.js` and `MODULE_PROTOCOL`
in `server/index.js` must be bumped together whenever the messages between them change.
