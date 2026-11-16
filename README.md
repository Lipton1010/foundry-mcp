# Foundry MCP

Lets a coding agent read and change a [Foundry VTT](https://foundryvtt.com) world through the GM's own browser
session, and see the warnings and errors its changes cause. It is for people who build macros, modules and
automation and want an agent that can run code in a **test** world.

Works with any MCP client that supports streamable HTTP servers. Tested with Claude Code, Codex, Cursor, OpenCode
and Antigravity (see [docs/clients.md](docs/clients.md)).

> **This gives the agent full GM power.** `foundry_eval` runs arbitrary JavaScript as the GM, and whatever the agent
> reads from your world is sent to the AI provider behind your client. Use a copy of your world and read
> [SECURITY.md](SECURITY.md) first.

## How it differs from other Foundry MCP servers

Most Foundry MCP servers help a GM run a game: they offer dozens or hundreds of tools for actors, tokens, combat and
dice. This one is for writing and debugging the code behind a game, and it is small on purpose.

- **It runs your code where Foundry runs it.** `foundry_eval` executes JavaScript in the GM's own tab, with every
  module and system loaded, rather than through a fixed list of tools or a separate API.
- **It reports what broke and which module broke it.** Warnings, errors and unhandled rejections are captured in the
  tab, including ones raised after a call has returned (a hook, a midi-qol workflow, a timer). Each is tagged with the
  modules on its stack and with whether your evaluated code was involved.
- **It keeps everything on your computer.** No hosted relay, no account and no paid tiers: the hub listens on
  loopback only, and nothing leaves your machine except what your MCP client sends to its AI provider.
- **It treats full GM power as the risk it is.** A hub token, a signed command channel between hub and module, a
  world allowlist that is empty by default, credential redaction in logs, and a read-only mode. See
  [SECURITY.md](SECURITY.md) for what is and is not protected.
- **It works with any game system and any streamable-HTTP MCP client.** Several clients share one hub.

If you want an assistant that runs combat or builds encounters for you, a GM-oriented server will suit you better.

## How it works

```
MCP client(s) ──HTTP POST /mcp──►  hub (Node, 127.0.0.1:30123)  ◄──WebSocket /foundry── Foundry module (GM tab)
```

- **Hub** (`server/`): one long-running Node process bound to loopback. Any number of MCP clients share it.
- **Module** (`foundry-mcp/`): a small script that, in a GM's tab, dials the hub, evaluates the JavaScript it is
  sent, and forwards warnings and errors. Foundry has no server-side API, so a logged-in GM tab is required.
- All tool logic lives in the hub, so Foundry or game-system updates rarely need a module change. The read-only
  tools are fixed code the hub sends; their arguments travel as data, never as code.
- Nothing is specific to one game system. Agents are told to call `foundry_status` first and not to assume a system
  or module.

## Tools

### `foundry_status`

No arguments. Call it first.

```json
{
  "result": {
    "world": "my-test-world", "worldTitle": "My Test World",
    "core": "14.370", "system": "dnd5e", "systemTitle": "Dungeons & Dragons Fifth Edition", "systemVersion": "6.0.6",
    "user": "Gamemaster", "activeScene": "Tavern", "viewedScene": "Tavern",
    "counts": { "actors": 58, "items": 20, "scenes": 49, "macros": 92, "journal": 98 },
    "activeModules": ["foundry-mcp@0.5.0", "lib-wrapper@1.13.5.1", "midi-qol@14.6.11"],
    "windowVisibility": "visible"
  },
  "logs": [],
  "logSeq": 12
}
```

### `foundry_documents`, `foundry_document`, `foundry_settings`

Three read-only tools for plain lookups. They run no code from the client, so they stay available with
`allowEval: false`, and `allowRead: false` removes them.

- `foundry_documents` lists. With no arguments it returns the world's collections with their sizes and its
  compendium packs. With `type` (`"Actor"`, `"JournalEntry"`, ...) it lists that collection, and with `pack` the
  entries of that compendium. Optional `name` (text the name must contain) and `limit` (default 50, at most 500).
  ```json
  // arguments: { "type": "Actor", "name": "tyrant" }
  { "result": { "type": "Actor", "total": 1, "documents": [
    { "id": "ZsaSGuRfxgI7ltMz", "name": "Aberrant Tyrant", "type": "npc", "folder": "REIbHyFCUL6GpE3p", "uuid": "Actor.ZsaSGuRfxgI7ltMz" }
  ] }, "logs": [], "logSeq": 12 }
  ```
- `foundry_document` reads one document by `uuid`, from the world or a compendium, embedded documents included
  (`Actor.<id>.Item.<id>`). It returns the stored data (`toObject()`), not values the game system derives at run
  time. Optional `fields` is a list of dot paths, so that a large document need not be returned whole.
  ```json
  // arguments: { "uuid": "Actor.ZsaSGuRfxgI7ltMz", "fields": ["name", "system.attributes.hp.max"] }
  { "result": { "uuid": "Actor.ZsaSGuRfxgI7ltMz", "documentName": "Actor",
    "fields": { "name": "Aberrant Tyrant", "system.attributes.hp.max": 180 } }, "logs": [], "logSeq": 12 }
  ```
- `foundry_settings` reads registered settings: namespace, key, scope, display name and value. Optional
  `namespace` (`"core"`, the system id or a module id), `contains` and `limit` (default 100, at most 500). A text
  value whose key is named like a credential (password, secret, cookie, api key, or ending in `token` or `key`) is
  returned as `withheld` instead. That is best effort: a secret stored under another name, or inside an object, is
  returned. Stored settings cannot be read through the two document tools. Reading a setting Foundry has
  deprecated makes Foundry print a warning, which then appears in `foundry_logs`.

### `foundry_eval`

Runs the body of an async function as the GM. Arguments: `code`, and optionally `timeoutMs` (default 30000).

```js
// code
const actor = game.actors.getName('Training Dummy');
await actor.setFlag('world', 'checked', true);
console.log('flag set');
return { hp: actor.system.attributes?.hp?.value, flag: actor.getFlag('world', 'checked') };
```

```json
{ "result": { "hp": 10, "flag": true }, "logs": [{ "level": "log", "text": "flag set" }], "logSeq": 12 }
```

- Documents and collections are returned as their `toObject()` data. Return only what you need; replies are capped
  at 80,000 characters and very large structures are cut off.
- `logs` is the console output while the call ran. `logSeq` is a cursor for `foundry_logs`.
- A thrown error comes back as `error` with its stack, and line numbers refer to `foundry-mcp-eval.js`, your code.
- `signal` is an `AbortSignal` that fires when the call times out. **A timeout does not stop the code**; only code
  that checks `signal.aborted` stops early.
- `logs` holds at most 200 lines per call; `logsDropped` counts the rest.
- At most 16 evaluations can be unfinished at once, across all clients. Code that outlived its timeout still
  counts, so after 16 stuck calls nothing more runs until the world is reloaded.

### `foundry_logs`

Reads warnings and errors captured in the GM tab, including ones raised after `foundry_eval` returned.
Arguments, all optional: `since`, `level` (`info`, `warn`, `error`), `package`, `contains`, `limit` (default 50),
`clear`.

```json
// arguments: { "since": 12, "package": "midi-qol" }
{
  "connected": true, "world": "my-test-world", "lastSeq": 14, "evicted": 0, "matched": 1,
  "entries": [{
    "seq": 14, "count": 1, "time": "2026-11-14T16:37:49.008Z", "level": "warn", "source": "console",
    "packages": ["midi-qol"], "fromEval": false,
    "text": "midi-qol | called macro error in ... ReferenceError: bonuss is not defined",
    "stack": ["at Macro.eval (eval at #executeScript (/scripts/foundry.mjs:53389:16), <anonymous>:4:46)", "..."]
  }]
}
```

See [Logs](#logs) for what is captured and [docs/demo-midi-qol.md](docs/demo-midi-qol.md) for a complete worked
example.

## Prerequisites

- Foundry VTT 14 (see [Tested versions](#tested-versions)) and GM access to a world you can afford to break.
- Node.js 20.11 or newer on the same computer as the GM's browser.
- The GM's browser must open Foundry at an address listed in the hub's `origins` (by default
  `http://localhost:30000`).
- An MCP client that supports streamable HTTP servers with custom headers. Claude Code and Codex run on an existing
  Claude or ChatGPT plan, so no separate API key is needed; the module itself never talks to an AI provider.

## Setup

1. **Get the code and install the hub.**
   ```
   git clone https://github.com/Lipton1010/foundry-mcp.git
   cd foundry-mcp/server
   npm ci
   ```
2. **Make a test world.** Create a new world in Foundry's setup screen, or, with Foundry shut down, copy your
   world's folder under `Data/worlds` to a new folder name and change `id` in the copy's `world.json` to that
   same name. Never point this at a campaign you cannot restore.
3. **Configure the hub.** Still in the `server` folder, copy `config.example.json` to `config.json` and replace `my-test-world-id`
   with the test world's id (its folder name under `Data/worlds`). With no worlds listed the hub refuses to run code.
4. **Start the hub** with `npm start` and leave it running. On first start it generates a token and saves it in
   `config.json` as `"token"`. A value of the wrong type in `config.json` stops the hub with a message rather than
   being guessed at.
5. **Install the module.** In Foundry's setup screen choose **Add-on Modules ► Install Module** and paste the
   manifest URL `https://github.com/Lipton1010/foundry-mcp/releases/latest/download/module.json`. The hub is not
   part of the module and comes from this repository; keep the two on the same version (check out the matching
   tag, for example `git checkout v0.5.0`). To work on the module itself, copy or link the `foundry-mcp` folder
   into Foundry's `Data/modules` folder instead and restart Foundry. On Windows a junction keeps it in step with
   your checkout:
   ```
   New-Item -ItemType Junction -Path "<Foundry user data>\Data\modules\foundry-mcp" -Target "<checkout>\foundry-mcp"
   ```
6. **Enable the module in the test world only** (Manage Modules ► Foundry MCP), then open Configure Settings ►
   Foundry MCP, paste the token into **Hub token**, save and reload. The hub prints
   `Foundry connected: world=<id> (allowed)`.
7. **Register the hub with your client**, giving it the same token. See [docs/clients.md](docs/clients.md) for Claude
   Code, Codex, Cursor, Antigravity and OpenCode. For example:
   ```
   claude mcp add --transport http --scope user foundry http://127.0.0.1:30123/mcp --header "Authorization: Bearer <token>"
   ```
8. **Verify** as described [below](#verifying-against-a-real-world).

### Configuration

`server/config.json` (git-ignored), or the environment variable, which wins:

| Key | Variable | Default | Meaning |
|---|---|---|---|
| `port` | `FOUNDRY_MCP_PORT` | `30123` | Loopback port for both `/mcp` and `/foundry`. |
| `worlds` | `FOUNDRY_MCP_WORLDS` | none | World ids code may run in. `*` allows any world; avoid it. |
| `origins` | `FOUNDRY_MCP_ORIGINS` | `http://localhost:30000`, `http://127.0.0.1:30000` | Page origins allowed to connect as Foundry: scheme, host and port only, matching the address in the GM's browser. Capital letters and a trailing `/` are tidied up; a path or `*` stops the hub with a message. |
| `token` | `FOUNDRY_MCP_TOKEN` (hub only; do not reuse this name for clients) | generated on first start | Shared secret. MCP clients send it as `Authorization: Bearer <token>`; the module proves it knows it. Set it to `""` to run without authentication (not recommended). A blank value, or one containing a line break, stops the hub with a message. |
| `allowEval` | `FOUNDRY_MCP_ALLOW_EVAL` | `true` | `false` removes `foundry_eval`: clients can still read status, logs, documents and settings, but cannot run code or change anything. |
| `allowRead` | `FOUNDRY_MCP_ALLOW_READ` | `true` | `false` removes `foundry_documents`, `foundry_document` and `foundry_settings`. With `allowEval` also `false`, clients can read status and logs only. |
| `logLimit` | `FOUNDRY_MCP_LOG_LIMIT` | `1000` | Log entries kept in memory, from 1 to 10000. |

Module settings (stored per browser): **MCP hub address** (default `ws://127.0.0.1:30123/foundry`; only loopback
addresses are accepted) and **Hub token**.

## Verifying against a real world

`npm test` exercises the hub and the real module script against *stubbed* Foundry globals. It proves the plumbing,
not Foundry. After setup, check your test world from your agent:

1. `foundry_status` returns your test world's id, system and modules, and `windowVisibility` is `visible`.
2. `foundry_eval` with `return game.actors.size` returns a number.
3. `foundry_eval` with `setTimeout(() => console.error('late probe'), 500); return 1` returns at once. A second or
   so later, `foundry_logs` with `since` set to the returned `logSeq` shows the entry with `fromEval: true`.
4. Reload the world (F5). `foundry_status` works again within about five seconds, and `foundry_logs` still shows the
   earlier entries followed by "Foundry disconnected" and "Foundry connected" markers.
5. From a terminal, `curl -i -X POST http://127.0.0.1:30123/mcp` answers `401` (token required). In Windows
   PowerShell 5 use `curl.exe`.

## Logs

The module captures, in the GM tab only:

- `console.warn` and `console.error` (most UI notifications also pass through these);
- uncaught exceptions and unhandled promise rejections.

Each entry carries `seq`, `time`, `level`, `source`, `text`, a trimmed `stack`, a repeat `count`, and two attribution
fields derived from the stack:

- `packages`: ids of the modules or systems whose code is on the stack, innermost first.
- `fromEval`: `true` when code sent through `foundry_eval` is on the stack.

These let an agent tell an error it caused or faked from one a module raised. A line that merely *says*
`midi-qol | ...` but was printed by evaluated code has `fromEval: true` and no `midi-qol` in `packages`; a real
midi-qol workflow failure has `midi-qol` in `packages`.

Attribution is a heuristic. A module that logs an error on behalf of a macro is the one named. Modules that wrap
core functions appear on unrelated stacks (midi-qol wraps notifications, so it is listed on most of them, and
libWrapper is listed wherever a wrapped function runs). `fromEval` is lost across some asynchronous boundaries, for
example a world macro that a module runs later.

Behaviour worth knowing:

- **Retention.** The hub keeps the newest `logLimit` entries in memory only. They survive world reloads and Foundry
  disconnects and can be read while Foundry is disconnected. They are lost when the hub restarts. Nothing is written
  to disk. `evicted` in every reply says how many entries have fallen off.
- **Start-up and offline errors.** Capture starts when the module script loads, and up to 200 entries are held in the
  tab until the hub accepts the connection.
- **Floods.** Identical consecutive entries collapse into one with a `count`. Beyond 100 entries per second the tab
  drops entries and the next one reports `droppedBefore`.
- **Querying.** The buffer is shared by all clients, so prefer `since` cursors. `clear` empties it for everyone.
- **Levels.** Many modules report real failures as warnings (midi-qol logs a failing on-use macro with
  `console.warn`), so do not filter to `error` only.
- **Privacy.** Only warnings and errors are kept, never ordinary `console.log` output. Values that look like
  credentials (`password=`, `api_key:`, `token=`, prefixed names such as `client_secret`, quoted keys such as `"token": "..."`, `Authorization` and
  `Cookie` headers, bearer tokens, `?token=` in URLs, passwords in addresses such as `redis://:password@host`, JWTs,
  AWS, Stripe, GitHub and Slack keys, long opaque strings, and the hub token itself) are
  replaced with `[redacted]` in the browser, in log entries and in the `logs` of `foundry_eval`. This is best effort.
  Because "token" and "secret" are everyday words at a game table, a plain `token: value` or `secret: value` is redacted
  only when the value looks machine-made (six or more characters with a digit, or twelve or more), so `Token: Goblin`
  survives and so would a short all-letter secret. Also not caught: a bare `key: value`, a password containing a space
  outside quotes, and long strings made of letters only. Log text
  is otherwise whatever your modules print, which can include actor, item and user names. Logs from worlds that are
  not on the allowlist are discarded.
- **Not captured.** `console.log/info/debug` outside an evaluation, notifications created with `console: false`,
  failed network or image loads, errors in other users' browsers, and errors thrown while modules are still being
  imported before this one.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "Foundry is not connected" | The module is not enabled, you are not logged in as GM, the hub started after the world loaded (it reconnects within 5 s), the token does not match, or the page address is not in `origins`. Press F12 in Foundry and look for lines starting `foundry-mcp |`. |
| `foundry-mcp | not connected: the hub requires a token` | Paste `token` from `server/config.json` into the module's Hub token setting and reload. The module retries every 30 s. |
| `... does not know the token` / `... did not ask for the token` | Something other than your hub answered on the hub port, or the hub's token changed. Check that only your hub is listening on the port. |
| `... token checks need a secure page` | Foundry is open at a plain `http://` address other than localhost. Open it at `http://localhost:<port>`, or serve it over https. |
| HTTP 401 from `/mcp` | The client is not sending `Authorization: Bearer <token>`. See [docs/clients.md](docs/clients.md). |
| HTTP 403 from `/mcp` | The request carried an `Origin` header (a browser) or a non-loopback `Host`. Use `127.0.0.1` or `localhost` in the client's URL. |
| "The world open in Foundry is not on this hub's allowlist" | The hub refused that world's connection and prints its id in the hub window. Add the id to `worlds` in `server/config.json` and restart the hub, if you really mean to. The module retries every 30 s. |
| "module ... is out of date" | Module and hub versions differ. Update the module folder and reload the world. |
| Hub prints nothing on world load | Foundry is served from another address (reverse proxy, hosting service, different port). Set `origins` to the exact origin in the address bar. |
| Calls time out, or automation finishes a minute late | `windowVisibility` is `hidden`: the Foundry window is minimized or covered and the browser is throttling its timers. Bring it to the front. |
| A second GM tab never connects | Only one tab is served. Close the other; the new one connects within 30 s. |
| "Port 30123 is already in use" | Another hub is running. Stop it, or change `port`. |
| A result contains `[Truncated ...]` and a `truncated` field | Return fewer fields; replies are capped at 80,000 characters. A cut reply is still valid JSON. |
| `foundry_logs` returns `entriesOmitted` | The matches did not fit in one reply, so the oldest were left out. Lower `limit` or raise `since`. |

## Tested versions

Tested by the author on one Windows 11 machine on 14 November 2026:

| Component | Version |
|---|---|
| Foundry VTT | 14.370 (desktop app, world served at `http://localhost:30000`) |
| Game system | dnd5e 6.0.6 |
| Automation modules present | midi-qol 14.6.11 and 14.6.12, DAE 14.6.9, libWrapper 1.13.5.1, and about 50 others |
| Node.js | 24.16 |
| MCP SDK | `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2 |
| Clients | Claude Code 2.1.325, Codex CLI 0.169.0, Cursor 3.30.14 (agent CLI 2026.11.13), OpenCode 2.3.0, Antigravity 2.32.1 |

### Tested against a real world

- `foundry_status` and `foundry_logs` from Claude Code, Codex, Cursor and OpenCode, with and without a hub token,
  and from Antigravity without one. `foundry_eval` from all five, read-only in every client but Claude Code and
  Codex, including a whole-collection result cut down to valid JSON.
- Reading and writing document flags, and automatic reconnection after a world reload.
- Logs: start-up warnings from other modules, an asynchronous error raised after `foundry_eval` returned, and a real
  midi-qol workflow whose on-use macro threw, attributed to `midi-qol`.
- Redaction of synthetic credentials in eval output, in an asynchronous console error and in a UI notification,
  including plain `token: value` lines and passwords inside connection addresses.
- Returning a whole collection (`return game.actors`): cut down to valid JSON within the reply limit. An oversized
  `foundry_logs` reply likewise, keeping the newest entries.
- Logging a real document 100 times from 16 evaluations at once: about 0.1 s of browser time each.
- The token handshake with the real module: the correct token connects, signed commands run, a signed cancel reaches
  the code after a timeout, a wrong token is refused, and a hub reached without the bearer token answers 401.
- A hub whose allowlist does not include the open world refuses its connection, runs nothing and keeps no logs.
- A clean install from a fresh clone, following the Setup steps, driven from Claude Code.
- The code of the three read-only tools, on 15 November 2026, sent through `foundry_eval` rather than by calling
  the tools: the collection and compendium overview (14 collections, 85 packs), a name search, a compendium
  listing, an actor read whole and by field, an embedded item, a compendium document, both error messages, and
  all 1200 registered settings, of which one text value was withheld and none was unreadable.
- The [midi-qol demo](docs/demo-midi-qol.md), start to finish.

### Tested in simulation only (`npm test`, 57 checks)

Serialization and its size limits (including replies cut down to valid JSON), the cost of one console line while
several evaluations run, timeouts and the abort signal, the concurrency caps, flood limits and retention,
origin, Host and method checks, malformed socket messages, a second GM tab, the world allowlist (including an empty
one), a relay altering the reported world or moving text between the reported fields, a module refusing an unsigned or replayed command or a hub that cannot prove it knows
the token or whose proof is wrong, a client that disconnects mid-call, a call in flight when Foundry disconnects, a socket that fails to send,
the official MCP client on the 2026-07-28 revision, configuration validation, a port already in use, a non-GM
user, the read-only tools (listing, searching, reading by UUID and by field, withheld settings, hostile
arguments), `allowEval: false`, `allowRead: false`, agreement between the version numbers and the manifest's
download address, token generation with file permissions, and a config file that cannot be saved or made private.

### Not tested

- **Antigravity** with a hub token. It has only been run against a tokenless hub.
- The read-only tools called by name from a client against a real world (their code has been; see above), and
  installing the module in Foundry through the manifest URL.
- Any game system other than dnd5e. Nothing depends on dnd5e, but no other system has been run.
- Foundry 13 or earlier (the manifest requires 14), macOS, and real Foundry on Linux or in a browser other than
  the desktop app. CI runs the simulated tests on Linux, and the hub's handling of its config file has been run
  by hand on Linux (WSL 2, Node 24.16): a token in a file owned by another account stops the hub, a world-readable
  file of your own is made private, and a new token is not written to a folder the hub cannot write to.
- Log attribution reads Chromium-style stack traces. The module itself has been run in Firefox 143, on a
  stand-in page rather than Foundry: the token handshake, redaction, and attribution of a log entry to evaluated
  code and to another module all worked. The Safari format is parsed but has never been run.
- Real Foundry behind HTTPS, a reverse proxy or a hosting service. On a stand-in page served over https with a
  self-signed certificate, the module connected from Edge 157 and Firefox 160 both straight to
  `ws://127.0.0.1` and to a `wss://` address on a local TLS proxy in front of the hub, and MCP calls worked
  through that proxy. Safari is known to be stricter about a secure page opening `ws://`. The GM's browser
  must run on the same computer as the hub in every case.
- Several GM tabs or several worlds at once.

### Planned, not built

- A listing on foundryvtt.com. Releases are published on GitHub, and the manifest URL installs from there.
- Persisting logs across hub restarts (deliberately absent for now, for privacy).

## Development

`npm test` in `server` takes about 45 seconds. `PROTOCOL` in `foundry-mcp/scripts/bridge.js` and `MODULE_PROTOCOL`
in `server/index.js` must be bumped together whenever the messages between them change. CI runs the tests on Linux
and Windows with Node 20 and 24.

To release: set the same version in `foundry-mcp/module.json` (`version` and `download`), `server/package.json`,
`server/package-lock.json` and the `McpServer` line in `server/index.js` (`npm test` checks that they agree), then
push a tag `v<version>`. The release workflow runs the tests and attaches `module.json` and `module.zip` to a
GitHub release. Foundry can only download them from a public repository.

## License

[MIT](LICENSE).
