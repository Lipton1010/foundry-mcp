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
- **It shows what changed, and makes dice repeatable.** Each call lists the documents created, updated or deleted
  while it ran, with earlier values: usually by your code or automation it set off, and each says which user made
  it. Dice can be seeded or forced, so a midi-qol workflow or an activity can be tested the same way every time.
- **It changes one thing safely, and can take it back.** `foundry_update` previews a change to one document, applies
  it only over the values it showed you, and `foundry_undo` reverses it unless someone has changed it since.
  `foundry_scene` answers "why can't this token see?" and "which lights are on this level?" in one call, and
  `foundry_screenshot` shows the canvas as the GM sees it.
- **It keeps everything on your computer.** No hosted relay, no account and no paid tiers: the hub listens on
  loopback only, and nothing leaves your machine except what your MCP client sends to its AI provider.
- **It treats full GM power as the risk it is.** A client token, a separate pairing token with which the hub and the
  module prove themselves to each other and sign every command, a world allowlist that is empty by default, a way to
  say which world a change is meant for, credential redaction in logs, and a read-only mode. See
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
- All tool logic lives in the hub, so Foundry or game-system updates rarely need a module change. Every tool but
  `foundry_eval` is fixed code the hub sends (in `server/page.js`); its arguments travel as data, never as code.
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
    "viewedLevel": { "id": "defaultLevel0000", "name": "Ground floor" },
    "counts": { "actors": 58, "items": 20, "scenes": 49, "macros": 92, "journal": 98 },
    "activeModules": ["foundry-mcp@0.7.0", "lib-wrapper@1.13.5.1", "midi-qol@14.6.12"],
    "windowVisibility": "visible",
    "session": "g8qm10yg"
  },
  "logs": [],
  "logSeq": 12
}
```

`session` identifies this load of the page and changes when the world reloads. Pass `world` and `session` as
`expectedWorld` and `expectedSession` to `foundry_eval`, `foundry_update`, `foundry_undo` and `foundry_dice`: if
another world has connected, or the page has reloaded, since you looked, nothing runs and the reply says so.

### `foundry_documents`, `foundry_document`, `foundry_settings`

Three read-only tools for plain lookups. They run no code from the client, so they stay available with
`allowEval: false`, and `allowRead: false` removes them.

- `foundry_documents` lists. With no arguments it returns the world's collections with their sizes and its
  compendium packs. With `type` (`"Actor"`, `"JournalEntry"`, ...) it lists that collection, and with `pack` the
  entries of that compendium. Optional `name` (text the name must contain), `limit` (default 50, at most 500) and
  `offset`. When more match than fit, the reply has `nextOffset`; pass it as `offset` for the next page. A page too
  long for one reply is shortened by whole rows (`shortened` says so), and `nextOffset` continues after the last one
  sent.
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
  `namespace` (`"core"`, the system id or a module id), `contains`, `limit` (default 100, at most 500) and
  `offset`, with `nextOffset` as above. A text
  value whose key is named like a credential (password, secret, cookie, api key, or ending in `token` or `key`) is
  returned as `withheld` instead. That is best effort: a secret stored under another name, or inside an object, is
  returned. Stored settings cannot be read through the two document tools. Reading a setting Foundry has
  deprecated makes Foundry print a warning, which then appears in `foundry_logs`.

### `foundry_scene`

Read-only answers to common scene questions, each in one call, for the scene the GM is viewing or the scene given
by `scene` (a UUID). Listed when `allowRead` is on.

- `check: "overview"` (the default): grid, token vision, fog, lighting (darkness, global light and whether it is lit
  at the current darkness), the scene's levels with how many tokens and lights each has, and counts of walls,
  regions and tiles.
- `check: "vision"` with `token` (a UUID or a name, of a token on that scene): the token's sight and detection modes,
  the actor's senses, its level, which players own it, the lights that reach it and whether they are lit, and
  plain-language `notes` such as "Sight range is 0 and global light is not lit" or "The actor has darkvision (60)
  but the token's vision mode is basic".
- `check: "lights"`: the lights and light-emitting tokens on a level (`level`, default the one being viewed), with
  range, colour, animation, darkness range and whether each is lit now.

Which level a light is on is read from its `levels` list or, when that is empty, estimated from its elevation, so it
is a good guide rather than Foundry's own answer. The notes are hints, not a full vision calculation: walls are not
considered.

### `foundry_screenshot`

The canvas as the GM sees it now (scene, level, pan and zoom), as a JPEG image, with the scene, level, view and image
size. Optional `maxWidth` (default 1024) and `quality` (default 0.7). Interface windows are not included. It works
while the window is hidden, but what is drawn then may lag behind. Listed when `allowRead` is on.

### `foundry_eval`

Runs the body of an async function as the GM. Arguments: `code`, and optionally `timeoutMs` (default 30000, for the
whole call, including setting up change tracking and reading the changes afterwards), `expectedWorld` and
`expectedSession`.

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
- `changes` lists the documents created, updated or deleted while the call ran. That is what the tab *saw*, not
  proof of cause: usually your code or something it set off (a hook, a module), but a change another user made at
  the same moment is listed too, and each entry's `user` and `self` say who made it. At most 100 are listed;
  `changesOmitted` counts the rest and `changesEvicted` counts any the tab no longer held. Browsers can report time
  coarsely, so a change made up to half a second before the call, and not already listed by an earlier call, is
  included too. Calls that overlap see each other's changes; whichever finishes first lists them, and no change is
  listed by two calls. If they could not be read in time, `changesUnavailable` says why.
  `changesSeq` and `session` are a cursor for `foundry_changes`, for changes that land after the call returned:
  ```json
  "changes": [{ "seq": 7, "action": "update", "documentName": "Actor", "uuid": "Actor.ZsaSGuRfxgI7ltMz",
    "name": "Training Dummy", "user": "Gamemaster", "self": true,
    "changes": [{ "path": "flags.world.checked", "value": true, "before": null }] }],
  "changesSeq": 6, "session": "g8qm10yg"
  ```

### `foundry_update` and `foundry_undo`

A safer way than `foundry_eval` to change one document, such as a light, a token's vision or an actor's flag.
Listed when `allowEval` is on.

```json
// arguments: { "uuid": "Scene.dWgZ...AmbientLight.QHmp...", "set": { "config.dim": 30, "flags.my-module.note": "lit" } }
{ "result": { "valid": true, "current": { "config.dim": 46.46, "flags.my-module.note": null },
  "exists": { "config.dim": true, "flags.my-module.note": false },
  "proposed": { "config.dim": 30, "flags.my-module.note": "lit" },
  "expected": "{\"change\":[[\"config.dim\",30],...],\"state\":[[\"config.dim\",true,46.46],...]}",
  "world": "my-test-world", "session": "g8qm10yg" } }
```

- Without `apply`, it previews: the change (`set`, dot path to value, and `remove`, a list of dot paths) is
  validated on a copy of the document and nothing is saved. An invalid change comes back as `valid: false` with
  Foundry's validation message. Paths that overlap (`flags.a` and `flags.a.b`), a path both set and removed, a
  write inside a value that is not an object, and a change larger than about 60,000 characters (use `foundry_eval`
  for those) are refused.
- To apply, call again with the same `set` and `remove`, `apply: true`, and the preview's `expected`. That records
  the exact change previewed and every affected path's value and whether it exists (an absent path is not the same
  as one holding `null`). If any of them has changed since the preview, nothing is saved and `conflicts` lists them.
  An `expected` from a preview of a different change, including the same paths with other values, is refused. An applied change returns `editId`; if a module hook refuses the update, the reply
  says so and nothing is recorded.
- Setting an object merges it into the object there, as Foundry's own updates do.
- An apply or undo keeps going if the client goes away, so a change that is saved is still recorded (see
  `list: true`). One the hub gives up on after two minutes is cancelled if it has not started saving.
- Applying and undoing through this hub happen one at a time per document, so two clients cannot both pass the same
  check. A change made in another tab, by another user or through `foundry_eval` at the same moment is not part of
  that queue; the check just before saving still catches one that has already landed.
- `foundry_undo` puts back each path's earlier value (an object whole, without keys the edit added), and removes
  paths, and the objects holding them, that the edit created. It does so only if the document still holds what the
  edit left there; otherwise it changes nothing and lists the conflicts, so a later change by anyone is never
  overwritten. Without `editId` it undoes the most recent edit in the connected world; `list: true` lists the edits
  the hub remembers (the last 100, until it restarts).
- Settings are changed with `foundry_eval` (`game.settings.set`).

### `foundry_changes`

Lists document changes the GM's tab has seen, from any user or module, newest last. Arguments, all optional:
`since` (a `changesSeq`) and `session` (the `session` it came with), `before` (to page back: pass `olderBefore`),
`documentName`, `uuid` (that document and the documents embedded in it) and `limit` (default 50). It is listed when
`allowRead` is on.

- An update lists each changed path with its new value (the first 100 paths; `morePaths` says when there were more).
  `before` is there for updates made from the GM's tab: each is matched to its own earlier values, copied when the
  update was sent, by an option that travels with the update, so updates to one document that overlap each get their
  own. (Two updates sent before either lands both report the value from before both.) Foundry tells other
  clients, and other tabs, only the result, so their updates have no `before`. A field removed with Foundry's
  deletion operator reads `"deleted": true`.
- A deletion carries the deleted document's data, if it is under 20,000 characters, so it can be created again.
- Tracking starts with the first call to `foundry_eval` or `foundry_changes` and lasts until the page reloads. A
  tracker left in the page by an older hub is replaced; the 0.6 tracker's hooks cannot be removed until the page
  reloads, but from then on they keep nothing. The newest 500 changes are kept, fewer when they are large (about
  2 MB in all), in the browser's memory only; `evicted` counts the rest, and `evictedSince` those newer than `since`.
  Long text values are cut. A reply too long to send whole leaves out the oldest entries, and `olderBefore` leads
  back to them.
- A cursor is only meaningful on the page it came from. If you pass `session` and the page has reloaded since,
  `since` is ignored, every change on the new page is listed, and `pageReloaded` says so.
- A text value under a credential-like name (password, secret, api key, a name ending in `token` or `key`, and so
  on) is `[withheld]`, at any depth inside an object or list (an item of a list is judged by the list's name), as
  are the values of settings named that way and credential-like fields inside a setting's stored value. Foundry's
  own fields named just `token` or `key` are kept, but only where Foundry puts them and only holding what Foundry
  puts there: a chat speaker's or a target's token id, and an Active Effect change's attribute path. A `token` or
  `key` anywhere else is withheld. This is best effort, as in `foundry_settings`.

### `foundry_dice`

Makes dice rolled in the GM's tab predictable, so that automation can be tested the same way every time. It is
listed when `allowEval` is on.

```json
// arguments: { "seed": 42, "next": [{ "faces": 20, "result": 20 }] }
{ "result": { "seed": 42, "queued": [{ "faces": 20, "result": 20 }], "forced": 0, "active": true } }
```

- `seed` (a whole number from 0 to 4294967295) replaces Foundry's random source with a seeded Mersenne Twister, so
  the same rolls in the same order give the same results. `null` restores Foundry's own.
- `next` queues exact results, at most 200 waiting. Each is used by the first die it fits: one with that many
  `faces`, if given, and a result within the die's range. Dice it does not fit roll normally. `clear` empties the
  queue first. A forced result still uses up one number from the seeded sequence.
- With no arguments it reports the state and changes nothing. Setting `seed` to `null` puts Foundry's random source
  back, and with an empty queue everything is back. Each of the three functions it replaces wraps whatever is in
  place at that moment, so another module's wrapper added earlier stays in the chain. If another module wraps
  them afterwards, its wrapper stays, and rolls pass through it to Foundry's own. Setting the seed or queueing a
  result when ours is no longer on top puts a fresh wrapper on top, without calling other modules' functions to look;
  while dice control is on, that wrapper answers before theirs.
- `expectedWorld` and `expectedSession` work as for `foundry_eval`.
- Only rolls evaluated in the GM's tab are affected. Players' own rolls, and code that calls `Math.random`
  itself, are not. A world reload undoes it.

### `foundry_logs`

Reads warnings and errors captured in the GM tab, including ones raised after `foundry_eval` returned.
Arguments, all optional: `since`, `before` (to page back: pass `olderBefore`), `level` (`info`, `warn`, `error`),
`package`, `contains`, `limit` (default 50), `clear`.

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
4. **Start the hub** with `npm start` and leave it running. On first start it generates two secrets and saves them in
   `config.json`: `"token"`, which MCP clients send, and `"moduleToken"`, with which the hub and the module prove
   themselves to each other. A value of the wrong type in `config.json` stops the hub with a message rather than
   being guessed at.
5. **Install the module.** In Foundry's setup screen choose **Add-on Modules ► Install Module** and paste the
   manifest URL `https://github.com/Lipton1010/foundry-mcp/releases/latest/download/module.json`. The hub is not
   part of the module and comes from this repository; keep the two on the same version (check out the matching
   tag, for example `git checkout v0.7.0`). To work on the module itself, copy or link the `foundry-mcp` folder
   into Foundry's `Data/modules` folder instead and restart Foundry. On Windows a junction keeps it in step with
   your checkout:
   ```
   New-Item -ItemType Junction -Path "<Foundry user data>\Data\modules\foundry-mcp" -Target "<checkout>\foundry-mcp"
   ```
6. **Enable the module in the test world only** (Manage Modules ► Foundry MCP), then open Configure Settings ►
   Foundry MCP, paste `moduleToken` (not `token`) into **Hub pairing token**, save and reload. The hub prints
   `Foundry connected: world=<id>`. Until a pairing token is pasted the module does not connect at all.
7. **Register the hub with your client**, giving it `token`. See [docs/clients.md](docs/clients.md) for Claude
   Code, Codex, Cursor, Antigravity and OpenCode. For example:
   ```
   claude mcp add --transport http --scope user foundry http://127.0.0.1:30123/mcp --header "Authorization: Bearer <token>"
   ```
8. **Verify** as described [below](#verifying-against-a-real-world).

### Configuration

`server/config.json` (git-ignored), or the environment variable, which wins:

| Key | Variable | Default | Meaning |
|---|---|---|---|
| `port` | `FOUNDRY_MCP_PORT` | `30123` | Loopback port for both `/mcp` and `/foundry`. `0` takes any free port and prints it (the tests use this). |
| `worlds` | `FOUNDRY_MCP_WORLDS` | none | World ids code may run in. `*` allows any world; avoid it. |
| `origins` | `FOUNDRY_MCP_ORIGINS` | `http://localhost:30000`, `http://127.0.0.1:30000` | Page origins allowed to connect as Foundry: an `http` or `https` scheme, host and port only, matching the address in the GM's browser. Capital letters and a trailing `/` are tidied up; a path, `*`, `null` or any other scheme stops the hub with a message. |
| `token` | `FOUNDRY_MCP_TOKEN` (hub only; do not reuse this name for clients) | generated on first start | Client secret. MCP clients send it as `Authorization: Bearer <token>`. Set it to `""` to let any program on this computer call the hub (not recommended). A blank value, or one containing a line break, stops the hub with a message. |
| `moduleToken` | `FOUNDRY_MCP_MODULE_TOKEN` | generated on first start | Pairing secret, pasted into the module. The hub and the module each prove they know it, and the hub signs every command with a key derived from it. It must differ from `token`, so a client token that reaches the wrong program cannot be used to pose as the hub to your GM tab. `""` turns pairing off; the module then connects only if its **Connect without a pairing token** setting is on. |
| `allowEval` | `FOUNDRY_MCP_ALLOW_EVAL` | `true` | `false` removes the tools that change the world (`foundry_eval`, `foundry_update`, `foundry_undo`, `foundry_dice`): clients can still read status, logs, documents, settings, scenes, screenshots and changes. |
| `allowRead` | `FOUNDRY_MCP_ALLOW_READ` | `true` | `false` removes `foundry_documents`, `foundry_document`, `foundry_settings`, `foundry_scene`, `foundry_screenshot` and `foundry_changes`. With `allowEval` also `false`, clients can read status and logs only. |
| `logLimit` | `FOUNDRY_MCP_LOG_LIMIT` | `1000` | Log entries kept in memory, from 1 to 10000. |

Module settings (stored per browser): **MCP hub address** (default `ws://127.0.0.1:30123/foundry`; only loopback
addresses are accepted), **Hub pairing token**, and **Connect without a pairing token** (off; only for a hub whose
`moduleToken` is `""`).

**Upgrading from 0.6.** The module used to share the client `token`. Start the 0.7 hub once: it adds `moduleToken`
to `config.json`. Paste that into **Hub pairing token** (a new setting; the old **Hub token** value is not used) and
reload the world. Until then the module does not connect. Clients keep using `token`. If you ran
without a token, the hub still generates `moduleToken`; to run without pairing as well, set `"moduleToken": ""` and
turn on **Connect without a pairing token**.

## Verifying against a real world

`npm test` exercises the hub and the real module script against *stubbed* Foundry globals. It proves the plumbing,
not Foundry. After setup, check your test world from your agent:

1. `foundry_status` returns your test world's id, system and modules, and `windowVisibility` is `visible`.
2. `foundry_eval` with `return game.actors.size` returns a number.
3. `foundry_eval` with `setTimeout(() => console.error('late probe'), 500); return 1` returns at once. A second or
   so later, `foundry_logs` with `since` set to the returned `logSeq` shows the entry with `fromEval: true`.
4. Reload the world (F5). `foundry_status` works again within about five seconds with a new `session`, and
   `foundry_logs` still shows the earlier entries followed by "Foundry disconnected" and "Foundry connected" markers
   (a dropped connection from the same page says "reconnected" instead).
5. `foundry_scene` returns your viewed scene's levels and lighting, and `foundry_screenshot` returns a picture of it.
6. From a terminal, `curl -i -X POST http://127.0.0.1:30123/mcp` answers `401` (token required). In Windows
   PowerShell 5 use `curl.exe`.

## Logs

The module captures, in the GM tab only:

- `console.warn` and `console.error` (most UI notifications also pass through these);
- uncaught exceptions and unhandled promise rejections.

Each entry carries `seq`, `time`, `level`, `source`, `text`, a trimmed `stack`, a repeat `count`, and two attribution
fields derived from the stack:

- `packages`: ids of the modules or systems whose code is on the stack, innermost first.
- `fromEval`: `true` when code sent through `foundry_eval` is on the stack. The hub's own tools run under another
  name (`foundry-mcp-tool.js`), so a warning one of them sets off is not marked as yours.

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
  AWS, Stripe, GitHub and Slack keys, long opaque strings, and the pairing token itself) are
  replaced with `[redacted]` in the browser, in log entries and in the `logs` of `foundry_eval`. A logged object has
  values under credential-like keys withheld before it is turned into text, and a quoted value whose end was cut off
  with a long line is redacted to the end of the text. This is best effort.
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
| "Foundry is not connected" | The module is not enabled, you are not logged in as GM, the hub started after the world loaded (it reconnects within 5 s), the pairing token does not match, or the page address is not in `origins`. Press F12 in Foundry and look for lines starting `foundry-mcp |`. |
| `foundry-mcp | not connecting: paste the hub's "moduleToken"` | The module has no pairing token. Paste `moduleToken` from `server/config.json` into **Hub pairing token** and reload. |
| `foundry-mcp | not connected: the hub requires a token` | As above; or the hub was given a `moduleToken` while the module was set to connect without one. The module retries every 30 s. |
| `... does not know the token` / `... did not ask for the token` | Something other than your hub answered on the hub port, or the hub's `moduleToken` changed. Check that only your hub is listening on the port. |
| `not connected: The module (protocol 6) and the hub (protocol 7) do not match` | Module and hub are from different releases. Update whichever is older and reload the world. |
| "This call expected world ..." or "expected page session ..." | Another world connected, or the world reloaded, since the agent called `foundry_status`. Nothing ran. Call `foundry_status` again. |
| `... token checks need a secure page` | Foundry is open at a plain `http://` address other than localhost. Open it at `http://localhost:<port>`, or serve it over https. |
| HTTP 401 from `/mcp` | The client is not sending `Authorization: Bearer <token>`. See [docs/clients.md](docs/clients.md). |
| HTTP 403 from `/mcp` | The request carried an `Origin` header (a browser) or a non-loopback `Host`. Use `127.0.0.1` or `localhost` in the client's URL. |
| "The world open in Foundry is not on this hub's allowlist" | The hub refused that world's connection and prints its id in the hub window. Add the id to `worlds` in `server/config.json` and restart the hub, if you really mean to. The module retries every 30 s. |
| Hub prints nothing on world load | Foundry is served from another address (reverse proxy, hosting service, different port). Set `origins` to the exact origin in the address bar. |
| Calls time out, or automation finishes a minute late | `windowVisibility` is `hidden`: the Foundry window is minimized or covered and the browser is throttling its timers. Bring it to the front. |
| A second GM tab never connects | Only one tab is served. Close the other; the new one connects within 30 s. |
| "Port 30123 is already in use" | Another hub is running. Stop it, or change `port`. |
| A result contains `[Truncated ...]` and a `truncated` field | Return fewer fields; replies are capped at 80,000 characters. A cut reply is still valid JSON. |
| `foundry_logs` returns `entriesOmitted` | The matches did not fit in one reply, so the oldest were left out. Lower `limit` or raise `since`. |
| `foundry_update` returns `conflicts` | The document changed after the preview. Preview again and apply with the new `expected`. |
| `foundry_undo` returns `conflicts` | Someone changed those paths after the edit, so undoing would overwrite them. Decide by hand, or set them back and undo. |

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
- `foundry_changes` and `foundry_dice`, on 17 November 2026: a midi-qol attack with the next d20 forced to 20
  landed as a critical hit, and the call listed the target's hit points with their earlier value, the chat cards
  and the flags other modules wrote; a change made after the call returned was found with `changesSeq`; deleted
  chat messages came back with their data, a credential-like flag withheld and the speaker's token id kept; the
  first calls on a freshly loaded page listed their changes; seed 42 gave the same d20 rolls twice, matching
  Foundry's own `MersenneTwister`, and turning it off restored Foundry's functions and random rolls.
- Version 0.7, on 18 November 2026: the module pairing with a separate `moduleToken`; `foundry_status` with the page
  session and viewed level; `foundry_eval` refused, with nothing run, for a wrong `expectedWorld` or a stale
  `expectedSession`, and run for the right ones; `foundry_scene` overview, lights and vision on a scene with 14
  lights and 3 tokens (the vision notes named token vision being off and no player owning the token);
  `foundry_screenshot` of the viewed scene; `foundry_update` previewing a light's range and colour, refusing a
  non-number range with Foundry's own validation message, applying over the previewed values, refusing a stale
  apply, and `foundry_undo` refusing while someone else's later change stood, then restoring the light exactly,
  including removing the flag object the edit had created; `before` values for updates from the GM's tab,
  matched through the option Foundry carries from `preUpdate` to `update`; a field removed with Foundry 14's
  `ForcedDeletion` reported as deleted; a seed cleared while a result was queued and set again seeding Foundry's
  rolls again, and turning control off restoring all three of Foundry's functions; a `foundry_changes` cursor from
  an earlier page reported as such; document paging; and redaction of a password whose closing quote was cut off
  and of an API key inside a logged object. After the review fixes, the same day: pairing through the new **Hub
  pairing token** setting after a real reload; a fingerprint for one value refused for another; overlapping paths
  refused; an edit to a light's range, animation object and a new flag, then undo restoring all three exactly; a
  module hook vetoing an update reported as not applied, with nothing to undo; a token from another scene refused;
  all 49 scenes paged five at a time, each once; and a queued 20 then seed 42 matching Foundry's own
  `MersenneTwister`, with none of the three wrappers left in place afterwards.
- The code of the three read-only tools, on 15 November 2026, sent through `foundry_eval` rather than by calling
  the tools: the collection and compendium overview (14 collections, 85 packs), a name search, a compendium
  listing, an actor read whole and by field, an embedded item, a compendium document, both error messages, and
  all 1200 registered settings, of which one text value was withheld and none was unreadable.
- The [midi-qol demo](docs/demo-midi-qol.md), start to finish.

### Tested in simulation only (`npm test`, 76 checks)

Serialization and its size limits (including replies cut down to valid JSON), the cost of one console line while
several evaluations run, timeouts and the abort signal, the concurrency caps, flood limits and retention,
origin, Host and method checks, malformed socket messages, a second GM tab, the world allowlist (including an empty
one), a relay altering the reported world or moving text between the reported fields, a module refusing an unsigned or replayed command or a hub that cannot prove it knows
the token or whose proof is wrong, a client that disconnects mid-call, a call in flight when Foundry disconnects, a socket that fails to send,
the official MCP client on the 2026-07-28 revision, configuration validation, a port already in use, a non-GM
user, the read-only tools (listing, searching, reading by UUID and by field, withheld settings, hostile
arguments), `allowEval: false`, `allowRead: false`, agreement between the version numbers and the manifest's
download address, token generation with file permissions, a config file that cannot be saved or made private, and
the change tracker and dice control. Also, for 0.7: the separate client and pairing tokens (neither works as the
other), a module without a pairing token not connecting unless told to, a module of another protocol turned away at
once, oversized and too many unproven connections, a signed send that fails leaving no gap in the sequence, two
hubs creating secrets in one new config at once, `null` and non-web origins refused, `expectedWorld` and
`expectedSession`, paging of documents, settings, logs and changes, a cursor from an earlier page, credentials in
nested setting values and Foundry-named `token` and `key` fields outside Foundry's own places, `before` values for
three overlapping updates and for updates from another tab, a 400-field update and the 2 MB buffer limit,
`changesEvicted` alongside `changesOmitted`, an older tracker replaced in place, dice wrappers added before, after
and instead of ours and the 200-result queue cap, `foundry_update` and `foundry_undo` with their conflicts,
`foundry_scene`'s three checks, `foundry_screenshot`, warnings from the hub's own tools not marked `fromEval`, and
redaction of cut-off quoted values and of logged objects. After the 0.7 review: a 0.6 pairing value left in the
old setting not used, the protocol check on a hub with a pairing token, the size limit on unproven connections
applied while a message arrives, earlier values copied before Foundry changes them in place, `token` and `key`
kept only on chat messages and Active Effects, the 0.6 tracker's hooks keeping nothing, a module hook that hands
ours only some dice (no wrapper calls itself), `foundry_update`'s fingerprint (every path, absent versus null, a
fingerprint from another change), overlapping paths, a refused update, an object put back whole, two clients
applying at once, an edit too large to undo, a token from another scene, and pages shortened to fit a reply
without skipping rows. After the second review: a reply the module did not sign refused, unproven connections
refused before the upgrade, a fingerprint for a removal not accepted for a literal value, an overlap hidden by a
sibling key, a write inside a value that is not an object refused, an undo a hook changed kept as not undone, and
a dice wrapper put on top without calling another module's function. After the third review: an unsigned welcome refused, an undo refused once the object holding a removed key was replaced by a value, an apply given up on before saving changing nothing, keys added in any order undone cleanly, and credentials inside JSON stored as text withheld. After the fourth review: malformed JSON text and repeated keys withheld, while ordinary text in brackets is kept; Foundry's older `==` replacement keys refused; undo never writing through a value a module put in place; and a removed absent sibling not leaving an empty object behind.

### Not tested

- **Evaluations that truly overlap in time** against a real world, and another module wrapping the dice functions
  there. Simulation covers both.
- **`foundry_scene` on a scene with several levels.** The test world has none, so level estimates for lights and
  tokens on multi-level scenes have only been simulated.
- **Antigravity** with a hub token. It has only been run against a tokenless hub.
- Installing the module through Foundry's own Install Module dialog. The v0.6.0 manifest and the zip it points to
  were downloaded and checked as Foundry reads them (module.json at the root, matching version, every script
  present, compatible with 14), but not installed by Foundry itself.
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

`npm test` in `server` takes about a minute. The code each tool runs in the page is in `server/page.js`, as ordinary
functions the tests also call directly. When the change tracker's code (`installChanges`) changes, raise its `VERSION` and the matching number in `queryChanges`, so a page that already has the tracker gets the new one without a reload. `PROTOCOL` in `foundry-mcp/scripts/bridge.js` and `MODULE_PROTOCOL` in
`server/index.js` must be bumped together whenever the messages between them change. CI runs the tests on Linux and
Windows with Node 20 and 24.

To release: set the same version in `foundry-mcp/module.json` (`version` and `download`), `server/package.json`,
`server/package-lock.json` and the `McpServer` line in `server/index.js` (`npm test` checks that they agree), then
push a tag `v<version>`. The release workflow runs the whole test matrix and the dependency audit, and only if they
pass attaches `module.json` and `module.zip` to a GitHub release. Foundry can only download them from a public
repository.

## License

[MIT](LICENSE).
