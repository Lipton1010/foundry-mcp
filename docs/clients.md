# Connecting MCP clients

Every client connects to the same hub at `http://127.0.0.1:30123/mcp` over **streamable HTTP** and must send the hub
token as `Authorization: Bearer <token>`. The token is the `"token"` value in `server/config.json` (not `"moduleToken"`, which is only for the module). Each client has
its own configuration file and key names; registering the hub in one does not register it in another.

Sanitized templates are in [`examples/`](../examples). Where a client can read the token from an environment
variable the templates do that, so the token is not copied into another file. Set it once, for example:

```
setx FOUNDRY_HUB_TOKEN "<token>"        # Windows; open a new terminal afterwards
export FOUNDRY_HUB_TOKEN="<token>"      # macOS / Linux
```

The variable is deliberately not called `FOUNDRY_MCP_TOKEN`: the hub reads that name as an override for its own
token, so setting it for your clients would silently pin the hub's token and defeat rotation. After rotating the
token, update `FOUNDRY_HUB_TOKEN` and restart your clients.

If you run the hub with `"token": ""`, leave out the `headers` / bearer settings below.

## Compatibility

| Client | Version tested | Transport | Auth header | Result |
|---|---|---|---|---|
| Claude Code | 2.1.325 | streamable HTTP | yes | **Tested end to end** against a real world, with and without token |
| Codex CLI | 0.169.0 | streamable HTTP | yes (from env var) | **Tested end to end**, with and without token |
| Cursor | 3.30.14 (editor), agent CLI 2026.11.13 | streamable HTTP | yes | **Tested end to end**, with and without token |
| OpenCode | 2.3.0 | streamable HTTP (`remote`) | yes | **Tested end to end**, with and without token |
| Antigravity | 2.32.1 | streamable HTTP (`serverUrl`) | yes, per documentation | **Tested end to end** without token. The `headers` form is from the documentation and has not been run |

"End to end" means the client listed the hub's tools (three at the time; there are twelve now), called `foundry_status` and got the test world back, and read
`foundry_logs`. Every test used a read-only call.

## Claude Code

```
claude mcp add --transport http --scope user foundry http://127.0.0.1:30123/mcp --header "Authorization: Bearer <token>"
```

`--scope user` makes it available in every project. For one project instead, put
[`examples/claude-code.mcp.json`](../examples/claude-code.mcp.json) in the project as `.mcp.json`; `${FOUNDRY_HUB_TOKEN}`
is expanded from the environment. Check with `claude mcp get foundry`.

## Codex

```
codex mcp add foundry --url http://127.0.0.1:30123/mcp --bearer-token-env-var FOUNDRY_HUB_TOKEN
```

This writes the block in [`examples/codex.config.toml`](../examples/codex.config.toml) to `~/.codex/config.toml`.
Codex reads the token from the named environment variable each time it starts. Check with `codex mcp get foundry`.

## Cursor

Put [`examples/cursor.mcp.json`](../examples/cursor.mcp.json) at `~/.cursor/mcp.json` (all projects) or
`<project>/.cursor/mcp.json` (one project). `${env:FOUNDRY_HUB_TOKEN}` is expanded from the environment, so start
Cursor from a session that has it set.

- The editor and the `agent` CLI read the same files.
- A project-level server starts disabled and must be switched on before it loads: in the editor under
  Customize ► MCPs ► foundry, or with `agent mcp enable foundry`. Until then the agent reports that the server
  is not among the live ones. Check with `agent mcp list` and `agent mcp list-tools foundry`.
- Cursor adds a tool of its own, `mcp_auth`, to every HTTP server; it is not part of this project.

## OpenCode

OpenCode 2.x keeps servers under `mcp.servers`. Merge [`examples/opencode.json`](../examples/opencode.json) into
`~/.config/opencode/opencode.json` (all projects) or `<project>/opencode.json`.

- `"type": "remote"` is streamable HTTP.
- `"oauth": false` is needed because the hub uses a plain bearer token, not OAuth.
- `{env:FOUNDRY_HUB_TOKEN}` is expanded from the environment.
- Check with `opencode mcp list`, run from the project folder.
- OpenCode's background service reads the environment when it starts. After setting `FOUNDRY_HUB_TOKEN`, restart
  that service (or log out and in), or the header is sent empty and the hub answers 401.
- OpenCode 1.x put server names directly under `mcp` and used `enabled`; that older shape is not tested here.

## Antigravity

This follows [Google's MCP documentation](https://antigravity.google/docs/mcp). Antigravity 2.32.1 read the global
file below as written and needed no approval step before calling the tools.

Put [`examples/antigravity.mcp_config.json`](../examples/antigravity.mcp_config.json) at
`~/.gemini/config/mcp_config.json` (all projects) or `<workspace>/.agents/mcp_config.json` (one workspace).

- The key is `serverUrl` (`url` is accepted as an alias). The older `httpUrl` key and the HTTP+SSE transport are not
  supported.
- The documentation describes no environment-variable expansion in `headers`, so the token has to be written into
  the file. Keep that file out of version control.
- The surest way to find the file your version reads is Manage MCP Servers ► View raw config inside Antigravity.
  Older releases used `~/.gemini/antigravity/mcp_config.json`.
- Prefer the global file. A workspace file puts the token in your project folder, where it is easy to commit.
- Restart the server from Customizations ► Installed ► MCP Servers after editing.
- Agent sessions started by other tools on top of Antigravity may not load workspace MCP servers at all. One such
  harness was tried and exposed none.

## Other clients

Any client that supports streamable HTTP with custom headers should work. Clients that only support stdio servers
need a stdio-to-HTTP bridge such as `mcp-remote`; that route is not tested.

## Checking a connection without an agent

```
curl -s -X POST http://127.0.0.1:30123/mcp \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A list of twelve tools (fewer if the hub has `allowEval` or `allowRead` turned off) means the hub and token are right. `401` means the token is missing or wrong. The command
is written for bash; in Windows PowerShell 5 use `curl.exe` and put it on one line.
