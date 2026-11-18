# Security

Foundry MCP is remote code execution in a GM's browser, on purpose. This page says what that exposes, what the
project does about it, and what it cannot do.

## What a connected agent can do

Anything the GM can do in Foundry's console: edit or delete every document in the world, read every setting
(including API keys other modules store), make network requests from the GM's browser, and affect connected
players. It also means:

- **Your world's content leaves your computer.** Whatever the agent reads is sent to the AI provider behind your MCP
  client and may be kept in its transcripts.
- **The agent can be steered by what it reads.** A journal entry, chat message or item description can contain text
  written to look like instructions. Imported content and anything players can edit should be treated as untrusted.
- **Agents make mistakes.** A wrong `deleteDocuments` call is as final as one you typed yourself.

## Recommended setup

1. Use a **copy** of your world. Never enable the module in a campaign you cannot restore, and keep backups.
2. Keep the generated **token** and **moduleToken** on. Both are the default.
3. List only the test world in `worlds`. Do not use `*`.
4. Keep your client's **approval prompts** for `foundry_eval`, `foundry_update` and `foundry_undo` on, at least until
   you trust a workflow. Prefer `foundry_update` (preview, then apply over the previewed values) to `foundry_eval`
   for changing one document, and pass `expectedWorld` and `expectedSession` on calls that change things.
5. Set `allowEval: false` when the agent only needs to read. It can then list and read documents, settings, scenes,
   screenshots and changes but cannot run code, fix dice or change anything. Add `allowRead: false` when you only
   need to watch status and logs.
6. Run the hub only while you are working, and disable the module when you are done with a world.

## Threats and safeguards

| Scenario | What protects you | What does not |
|---|---|---|
| **A web page you visit** tries to call the hub or to pose as the Foundry tab. | The hub listens on `127.0.0.1` only. `/mcp` rejects every request that carries an `Origin` header, accepts only `POST`, and rejects a `Host` that is not loopback (DNS rebinding). `/foundry` accepts WebSockets only from the configured page origins, which a browser cannot forge. | A page served from an origin you listed in `origins`. Anything else running on that address and port is trusted as if it were Foundry. |
| **Another account on the same computer** connects to the loopback port. | The tokens. Without `token` they cannot call `/mcp` (401); without `moduleToken` they cannot complete the `/foundry` handshake. At most four connections may be part-way through the handshake at once, and a message over 4 KB before it is complete ends the connection, so a noisy program cannot tie up the hub. | Nothing, if you set both to `""`. |
| **Another account takes the port while your hub is stopped**, and your MCP client calls it. | Clients send `token` to whatever answers on the port, so that program learns it. It cannot use it to pose as the hub to your GM tab: that needs `moduleToken`, which clients never send. | It can use `token` against your real hub once it is running again, with full GM power. The client cannot tell which program it is talking to (plain loopback HTTP has no server identity). On a computer other people log in to, stop your clients when you stop the hub, and rotate `token` if you suspect this happened. |
| **Something impersonates the hub**, or sits between the module and the hub: a program listens on the hub port while your hub is stopped, or relays the connection. | The module has a pairing token, and does not connect at all without one unless you turn on **Connect without a pairing token**. The hub must prove it knows the pairing token before the module obeys it: an HMAC over fresh nonces from both sides and over the world id the module reported, so a relay cannot change it. After that, every command the hub sends carries a sequence number and a signature under a key derived for that connection, covering the code and whether it is the caller's or the hub's own; the module drops the connection on an unsigned, altered, replayed or out-of-order command. Replies, and the hub's welcome, come back signed under the same key, and the other side drops the connection on one that is not, so a relay cannot alter a result, or the undo record the hub keeps from one. | A module set to connect without a pairing token obeys whatever answers. A program that can read `config.json` knows both tokens. The connection is not encrypted: a relay could read commands, results and logs. Log entries are not signed, so a relay could alter or invent them. Replies are not numbered, so a relay could hold one back, which the hub sees as a timeout. Keep the module's hub address on `127.0.0.1`, which only your hub can answer while it is running. |
| **A program running as you** (malware, a compromised dependency, another agent). | Nothing in this project. | It can read the tokens from `config.json` or your client's configuration, and it could read Foundry's files directly anyway. |
| **A change meant for one world lands in another**, because the GM switched worlds (both allowed) between the agent reading and writing. | `foundry_status` reports the world and a page `session`. Calls that change things accept `expectedWorld` and `expectedSession`, and run nothing if another world, or a reloaded page, is connected. `foundry_update` also re-checks every value it previewed, and whether each path exists, just before saving. | Calls that do not pass them. Agents are told to, but it is their choice. |
| **Two writers at once** overwrite each other. | `foundry_update` and `foundry_undo` run one at a time per document, under a lock in the GM's tab that is held until Foundry has answered (however long the caller waits), and each checks the document again inside it. Undo refuses if anything it would put back has changed since the edit, and puts objects back whole. | A write from another tab, another user or `foundry_eval` that lands between that last check and Foundry saving. Foundry has no conditional write, so this window cannot be closed from the module. |
| **The wrong world**: you open your live campaign while the hub is running. | The module does nothing unless it is enabled in that world. The hub refuses the connection of any world that is not on its allowlist, which is empty by default: no code runs there, none of its logs are kept, its id is not shown to clients, and it cannot block the test world's tab. | The allowlist relies on the world id the module reports. It guards against mistakes, not against a tampered module. `"worlds": ["*"]` removes it. |
| **A player** tries to use the bridge. | The module connects only for GM users, and only to a loopback address on the GM's own computer. | A GM or assistant GM account that is compromised is already full control of the world. |
| **Runaway or stuck code.** | Calls time out (30 s by default). The timeout aborts the `signal` passed to the code. The browser refuses to start more than 16 unfinished evaluations, counting ones that already timed out, and caps the size of results and captured console output. A console line is turned into text once, with a small allowance, however many evaluations are running. | JavaScript cannot be stopped from outside. Code that ignores `signal` keeps running, and keeps its slot, until it finishes or the world is reloaded (F5). |
| **Secrets in logs.** | Only warnings and errors are kept (plus the hub's own connect and disconnect markers), in memory, never on disk. Credential-looking values are redacted in the browser before they reach the hub, including values under credential-like keys in logged objects (withheld before the object becomes text) and quoted values cut off with a long line. Logs from worlds off the allowlist are dropped. | Redaction is pattern matching and will miss some formats: a bare `key: value`, a short all-letter value after a plain `token:` or `secret:` (kept so that `Token: Goblin` survives), an unquoted password containing a space, and long strings of letters only. Values returned by `foundry_eval` are not redacted at all, and the agent can read any setting directly. `foundry_settings` withholds only text values under credential-like key names. |
| **Many clients at once.** | Each call is matched to its own reply. | Clients are not isolated from each other: they share the log buffer (including `clear`), and console output from concurrent evaluations can appear in each other's `logs`. Treat every client with the token as one trust level. |

## Read-only mode

With `allowEval: false` a client cannot send code or change the world. `foundry_status`, `foundry_documents`,
`foundry_document`, `foundry_settings`, `foundry_scene`, `foundry_screenshot` and `foundry_changes` are fixed code
written in the hub (`server/page.js`); a client's arguments are checked for shape and passed to that code as JSON
data. What this does not change:

- **Reading is still disclosure.** Everything these tools return goes to the AI provider behind the client:
  journals, chat, GM notes, user names and settings.
- **Withholding secrets in settings is best effort.** A text value is withheld when its key, or the key it sits
  under inside an object, is named like a credential (password, passcode, passphrase, secret, cookie, api key, or ending in `token` or
  `key`), and URLs that carry their secret in themselves (webhooks, passwords in addresses, tokens in queries) have
  that part withheld. A secret in any other form is returned. Stored settings are not readable through the document tools, which would
  sidestep this. The module's pairing token itself is withheld by this rule.
- **A screenshot shows what the GM sees**, including hidden tokens and GM-only drawings, and it goes to the AI
  provider like any other reply.
- **Text the agent reads can still steer it**, and with other tools available to the same agent that matters even
  when this hub cannot change the world.
- **The module is unchanged.** It still evaluates whatever its hub sends; read-only is a property of the hub. Use
  the token so that only your hub can be that hub.
- **`foundry_changes` reports what everyone does.** It lists changes from every user, players included, while the
  tab is open. Its buffer lives in the GM's browser memory only, and credential-like text values are withheld, at
  any depth, on the same best-effort rule as settings. Fields named just `token` or `key` are kept only where
  Foundry itself puts them (a chat speaker's or target's token id, an Active Effect change's attribute path) and
  only when they look like what Foundry puts there. Text that holds JSON (a module keeping a profile as a string)
  is read and scrubbed the same way; such text too long to read safely is withheld. A URL that carries its secret
  in itself (a Discord or Slack webhook, a password in the address, a token in the query) has that part withheld
  whatever the field is called.

## The tokens

There are two, and they must differ:

- **`token`** is for MCP clients. It is stored in each client's configuration (or an environment variable), and
  clients send it as a bearer header over loopback HTTP on every call.
- **`moduleToken`** pairs the hub and the module. It is stored in the browser, in Foundry's client settings, where
  any module or macro running in that world on that browser can read it. It never crosses the socket: both ends
  prove knowledge of it with HMAC-SHA256 over nonces, so listening on the socket does not reveal it, and it is
  scrubbed from anything the module logs.

Keeping them apart means a client token that reaches the wrong program (see the table above) does not let that
program pose as the hub to your GM tab, and a pairing token read from the browser does not let a program call the
hub's tools.

- Both are generated on first start, 24 random bytes each, and saved in `server/config.json` once the hub has its
  port (so a second hub started by mistake saves nothing), under a lock file that is never taken from another hub:
  if a hub crashed while saving, its `config.json.lock` has to be deleted by hand, and the next hub says so. On macOS and Linux the hub sets that file readable only
  by you each time it starts with a token, and refuses to start if it cannot; on Windows it inherits the folder's
  permissions. A token you set yourself must be at least 16 characters.
- The handshake needs the browser's Web Crypto, which browsers provide only on `localhost` or `https` pages. If the
  GM opens Foundry at a plain `http://192.168...` address, the module refuses to connect to a hub that has a
  pairing token.
- To rotate one, stop the hub, change its value to `null` (for example `"moduleToken": null`), start the hub, and
  copy the new value into the module setting (for `moduleToken`) or every client (for `token`). A value from the
  `FOUNDRY_MCP_TOKEN` or `FOUNDRY_MCP_MODULE_TOKEN` environment variable overrides `config.json`; change it there.

## What is not protected

- Other programs running under your own account.
- The traffic between your MCP client and its AI provider, and that provider's retention.
- Foundry itself, your other modules, and anything they do with the access a GM session has.
- Players' browsers. Code the agent runs can still reach them through Foundry's own sockets.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" button on the repository's Security tab, not in
a public issue. (Maintainers: that button exists only once private vulnerability reporting is enabled in the
repository settings.)
