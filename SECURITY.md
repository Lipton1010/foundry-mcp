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
2. Keep the generated **token** on. It is the default.
3. List only the test world in `worlds`. Do not use `*`.
4. Keep your client's **approval prompts** for `foundry_eval` on, at least until you trust a workflow.
5. Set `allowEval: false` when the agent only needs to read. It can then list and read documents and settings but
   cannot run code or change anything. Add `allowRead: false` when you only need to watch status and logs.
6. Run the hub only while you are working, and disable the module when you are done with a world.

## Threats and safeguards

| Scenario | What protects you | What does not |
|---|---|---|
| **A web page you visit** tries to call the hub or to pose as the Foundry tab. | The hub listens on `127.0.0.1` only. `/mcp` rejects every request that carries an `Origin` header, accepts only `POST`, and rejects a `Host` that is not loopback (DNS rebinding). `/foundry` accepts WebSockets only from the configured page origins, which a browser cannot forge. | A page served from an origin you listed in `origins`. Anything else running on that address and port is trusted as if it were Foundry. |
| **Another account on the same computer** connects to the loopback port. | The token. Without it they cannot call `/mcp` (401) and cannot complete the `/foundry` handshake. | Nothing, if you set `"token": ""`. |
| **Something impersonates the hub**, or sits between the module and the hub: a program listens on the hub port while your hub is stopped, or relays the connection. | With a token set in the module, the hub must prove it knows the token before the module obeys it: an HMAC over fresh nonces from both sides and over the world id the module reported, so a relay cannot change it. After that, every command the hub sends carries a sequence number and a signature under a key derived for that connection; the module drops the connection on an unsigned, altered, replayed or out-of-order command. | A module with no token configured obeys whatever answers. A program that can read `config.json` knows the token. The connection is not encrypted and replies are not signed: a relay could read results and logs, or alter them on their way back to the hub. Keep the module's hub address on `127.0.0.1`, which only your hub can answer while it is running. |
| **A program running as you** (malware, a compromised dependency, another agent). | Nothing in this project. | It can read the token from `config.json` or your client's configuration, and it could read Foundry's files directly anyway. |
| **The wrong world**: you open your live campaign while the hub is running. | The module does nothing unless it is enabled in that world. The hub refuses the connection of any world that is not on its allowlist, which is empty by default: no code runs there, none of its logs are kept, its id is not shown to clients, and it cannot block the test world's tab. | The allowlist relies on the world id the module reports. It guards against mistakes, not against a tampered module. `"worlds": ["*"]` removes it. |
| **A player** tries to use the bridge. | The module connects only for GM users, and only to a loopback address on the GM's own computer. | A GM or assistant GM account that is compromised is already full control of the world. |
| **Runaway or stuck code.** | Calls time out (30 s by default). The timeout aborts the `signal` passed to the code. The browser refuses to start more than 16 unfinished evaluations, counting ones that already timed out, and caps the size of results and captured console output. A console line is turned into text once, with a small allowance, however many evaluations are running. | JavaScript cannot be stopped from outside. Code that ignores `signal` keeps running, and keeps its slot, until it finishes or the world is reloaded (F5). |
| **Secrets in logs.** | Only warnings and errors are kept (plus the hub's own connect and disconnect markers), in memory, never on disk. Credential-looking values are redacted in the browser before they reach the hub. Logs from worlds off the allowlist are dropped. | Redaction is pattern matching and will miss some formats: a bare `key: value`, a short all-letter value after a plain `token:` or `secret:` (kept so that `Token: Goblin` survives), an unquoted password containing a space, and long strings of letters only. Values returned by `foundry_eval` are not redacted at all, and the agent can read any setting directly. `foundry_settings` withholds only text values under credential-like key names. |
| **Many clients at once.** | Each call is matched to its own reply. | Clients are not isolated from each other: they share the log buffer (including `clear`), and console output from concurrent evaluations can appear in each other's `logs`. Treat every client with the token as one trust level. |

## Read-only mode

With `allowEval: false` a client cannot send code. `foundry_status`, `foundry_documents`, `foundry_document` and
`foundry_settings` and `foundry_changes` are fixed code written in the hub; a client's arguments are checked for shape and passed to
that code as JSON data. What this does not change:

- **Reading is still disclosure.** Everything these tools return goes to the AI provider behind the client:
  journals, chat, GM notes, user names and settings.
- **Withholding secrets in settings is best effort.** A text value is withheld only when its key is named like a
  credential (password, secret, cookie, api key, or ending in `token` or `key`). A secret under any other name, or
  inside an object, is returned. Stored settings are not readable through the document tools, which would
  sidestep this. The hub token itself is withheld by this rule.
- **Text the agent reads can still steer it**, and with other tools available to the same agent that matters even
  when this hub cannot change the world.
- **The module is unchanged.** It still evaluates whatever its hub sends; read-only is a property of the hub. Use
  the token so that only your hub can be that hub.
- **`foundry_changes` reports what everyone does.** It lists changes from every user, players included, while the
  tab is open. Its buffer lives in the GM's browser memory only, and credential-like text values are withheld on
  the same best-effort rule as settings.

## The token

- Generated on first start: 24 random bytes, stored as `token` in `server/config.json`. On macOS and Linux the hub
  sets that file readable only by you each time it starts with a token, and refuses to start if it cannot; on
  Windows it inherits the folder's permissions. A token you set yourself must be at least 16 characters.
- It also has to be stored in each MCP client's configuration (or an environment variable) and in the browser, in
  Foundry's client settings. Any module or macro running in that world on that browser can read it there.
- MCP clients send it as a bearer header over loopback HTTP on every call. The module never sends it: both ends prove
  knowledge of it with HMAC-SHA256 over nonces, so listening on the socket does not reveal it. It is also scrubbed
  from anything the module logs.
- The handshake needs the browser's Web Crypto, which browsers provide only on `localhost` or `https` pages. If the
  GM opens Foundry at a plain `http://192.168...` address, the module refuses to connect to a hub that has a token.
- To rotate it, stop the hub, change the value to `null` (`"token": null`), start the hub, and copy the new value
  into the module setting and every client. If the hub's token comes from the `FOUNDRY_MCP_TOKEN` environment variable
  instead, change it there: the variable overrides `config.json`.

## What is not protected

- Other programs running under your own account.
- The traffic between your MCP client and its AI provider, and that provider's retention.
- Foundry itself, your other modules, and anything they do with the access a GM session has.
- Players' browsers. Code the agent runs can still reach them through Foundry's own sockets.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" button on the repository's Security tab, not in
a public issue. (Maintainers: that button exists only once private vulnerability reporting is enabled in the
repository settings.)
