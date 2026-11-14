// Foundry MCP hub: one long-running process with two faces on one loopback port.
//
//   MCP clients (Claude Code, Codex, ...) --HTTP POST /mcp-->       this process
//   Foundry module (GM browser tab)       --WebSocket /foundry-->   this process
//
// The module only knows how to evaluate JavaScript and to forward warnings and
// errors, so every tool is defined here.

import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/server';
import { localhostHostValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------- config
// Values come from config.json next to this file (see config.example.json);
// FOUNDRY_MCP_* environment variables override it.

const configFile = process.env.FOUNDRY_MCP_CONFIG ?? join(import.meta.dirname, 'config.json');
const fileConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
const list = (text) => text?.split(',').map((s) => s.trim()).filter(Boolean);
const config = {
  port: Number(process.env.FOUNDRY_MCP_PORT ?? fileConfig.port ?? 30123),
  // World ids this hub may run code in. Empty means none; "*" means any.
  worlds: list(process.env.FOUNDRY_MCP_WORLDS) ?? fileConfig.worlds ?? [],
  // Browser origins allowed to connect as Foundry. Browsers cannot forge
  // Origin, so this keeps other web pages from posing as the Foundry tab.
  origins: list(process.env.FOUNDRY_MCP_ORIGINS) ?? fileConfig.origins ?? ['http://localhost:30000', 'http://127.0.0.1:30000'],
  // Optional shared secret, required from MCP clients and the module when set.
  token: process.env.FOUNDRY_MCP_TOKEN ?? fileConfig.token ?? '',
  logLimit: Number(process.env.FOUNDRY_MCP_LOG_LIMIT ?? fileConfig.logLimit ?? 1000),
};

const MODULE_PROTOCOL = 2;
const MAX_RESULT_CHARS = 80_000;
const worldAllowed = (world) => config.worlds.includes('*') || config.worlds.includes(world);
const tokenMatches = (given) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ------------------------------------------------------------------------ logs
// Warnings and errors pushed by the module, kept in memory only. They outlive
// world reloads and Foundry disconnects, but not a hub restart.

const logs = [];
let lastSeq = 0;
let evicted = 0;

function addLog(entry) {
  const last = logs.at(-1);
  const sameAsLast =
    last && ['world', 'session', 'level', 'source', 'text'].every((key) => last[key] === entry[key]) && last.packages.join() === entry.packages.join();
  if (sameAsLast) {
    // A repeating error (a render loop, say) becomes one entry with a count.
    last.count += 1;
    last.lastTime = entry.time;
    last.seq = ++lastSeq;
    return;
  }
  logs.push({ seq: ++lastSeq, count: 1, ...entry });
  if (logs.length > config.logLimit) {
    logs.shift();
    evicted += 1;
  }
}

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

function addFoundryLog(hello, raw) {
  if (!raw || typeof raw !== 'object') return;
  addLog({
    time: new Date(Number(raw.time) || Date.now()).toISOString(),
    world: hello.world,
    session: hello.session,
    level: raw.level === 'error' ? 'error' : 'warn',
    source: ['console', 'uncaught', 'rejection'].includes(raw.source) ? raw.source : 'console',
    packages: Array.isArray(raw.packages) ? raw.packages.slice(0, 10).map((id) => clip(id, 100) ?? '') : [],
    fromEval: raw.fromEval === true,
    text: clip(raw.text, 4000) ?? '',
    stack: Array.isArray(raw.stack) ? raw.stack.slice(0, 8).map((frame) => clip(frame, 300) ?? '') : [],
    ...(Number(raw.droppedBefore) > 0 ? { droppedBefore: Number(raw.droppedBefore) } : {}),
  });
}

function addBridgeLog(hello, text) {
  addLog({ time: new Date().toISOString(), world: hello.world, session: hello.session, level: 'info', source: 'bridge', packages: [], fromEval: false, text, stack: [] });
}

const LEVELS = ['info', 'warn', 'error'];

function queryLogs({ since = 0, level = 'info', package: pkg, contains, limit = 50, clear = false }) {
  const needle = contains?.toLowerCase();
  const matched = logs.filter(
    (entry) =>
      entry.seq > since &&
      LEVELS.indexOf(entry.level) >= LEVELS.indexOf(level) &&
      (pkg === undefined || entry.packages.includes(pkg)) &&
      (needle === undefined || `${entry.text}\n${entry.stack.join('\n')}`.toLowerCase().includes(needle))
  );
  const result = {
    connected: Boolean(foundry),
    world: foundry?.hello.world ?? null,
    lastSeq,
    evicted,
    matched: matched.length,
    entries: matched.slice(-limit),
  };
  if (clear) logs.length = 0;
  return result;
}

// ---------------------------------------------------------------- Foundry side

let foundry = null; // { ws, hello } for the one connected GM tab
const pending = new Map(); // request id -> { resolve, reject, timer }

function callFoundry(code, timeoutMs = 30_000) {
  if (!foundry) {
    throw new Error(
      'Foundry is not connected. Launch Foundry, open a world with the "Foundry MCP" module enabled, and log in as a GM.'
    );
  }
  const { world, protocol } = foundry.hello;
  if (!worldAllowed(world)) {
    throw new Error(
      `World "${world}" is not on this hub's allowlist, so no code will be run in it. ` +
        'The person running the hub can allow it by adding its id to "worlds" in server/config.json and restarting the hub.'
    );
  }
  if (protocol !== MODULE_PROTOCOL) {
    throw new Error(`The Foundry MCP module in the world is out of date (protocol ${protocol}, hub expects ${MODULE_PROTOCOL}). Update the module files and reload the world.`);
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs} ms. The code may still be running in Foundry.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    foundry.ws.send(JSON.stringify({ id, method: 'eval', params: { code } }));
  });
}

function onFoundryConnection(ws) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.hello) return onHello(ws, msg.hello);
    if (foundry?.ws !== ws) return; // nothing is accepted before a valid hello
    if (msg.log) {
      if (worldAllowed(foundry.hello.world)) addFoundryLog(foundry.hello, msg.log);
      return;
    }
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    clearTimeout(request.timer);
    request.resolve(msg);
  });
  ws.on('close', () => {
    if (foundry?.ws !== ws) return;
    console.error('[foundry-mcp] Foundry disconnected');
    if (worldAllowed(foundry.hello.world)) addBridgeLog(foundry.hello, 'Foundry disconnected (world reload, tab closed, or network drop)');
    foundry = null;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error('Foundry disconnected before replying (world reload or tab closed).'));
      pending.delete(id);
    }
  });
}

function onHello(ws, hello) {
  if (foundry?.ws === ws) return;
  if (config.token && !tokenMatches(hello.token)) return ws.close(4003, 'Hub token missing or wrong');
  if (foundry) return ws.close(4001, 'Another GM tab is already connected');
  foundry = {
    ws,
    hello: {
      world: String(hello.world),
      user: String(hello.user),
      core: String(hello.core),
      system: String(hello.system),
      session: String(hello.session ?? ''),
      protocol: hello.protocol ?? 1,
    },
  };
  const allowed = worldAllowed(foundry.hello.world);
  console.error(`[foundry-mcp] Foundry connected: world=${foundry.hello.world} (${allowed ? 'allowed' : 'NOT on the allowlist; code will be refused'})`);
  if (allowed) addBridgeLog(foundry.hello, 'Foundry connected (new page session; earlier entries are from before the reload)');
  ws.send(JSON.stringify({ welcome: true }));
}

// -------------------------------------------------------------------- MCP side

const asText = (value) => {
  let text = JSON.stringify(value, null, 1);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated ${text.length - MAX_RESULT_CHARS} chars; ask for less data]`;
  }
  return text;
};

async function runTool(code, timeoutMs) {
  const logSeq = lastSeq;
  try {
    const reply = await callFoundry(code, timeoutMs);
    const body = reply.ok ? { result: reply.result } : { error: reply.error };
    return { content: [{ type: 'text', text: asText({ ...body, logs: reply.logs, logSeq }) }], isError: !reply.ok };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
}

const INSTRUCTIONS =
  'Controls a live Foundry VTT world through the GM\'s browser session. Call foundry_status first: it reports the Foundry ' +
  'version, game system and active modules, which differ between users, so never assume a particular system or module. ' +
  'foundry_eval runs JavaScript with full GM rights; prefer reading before writing and keep changes narrow. Automation ' +
  'often fails asynchronously after a call returns: pass the logSeq from a foundry_eval result as `since` to foundry_logs ' +
  'to see warnings and errors raised from that call onward.';

function buildMcpServer() {
  const server = new McpServer({ name: 'foundry', version: '0.2.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'foundry_status',
    {
      description:
        'Report whether a Foundry VTT world is connected, and its world, core version, game system, active scene and active modules. ' +
        'Call this first; systems and modules differ between users.',
      inputSchema: z.object({}),
    },
    () =>
      runTool(`return {
        world: game.world.id, worldTitle: game.world.title,
        core: game.version, system: game.system.id, systemTitle: game.system.title, systemVersion: game.system.version,
        user: game.user.name, activeScene: game.scenes.active?.name ?? null, viewedScene: canvas.scene?.name ?? null,
        counts: { actors: game.actors.size, items: game.items.size, scenes: game.scenes.size, macros: game.macros.size, journal: game.journal.size },
        activeModules: game.modules.filter((m) => m.active).map((m) => m.id + '@' + m.version),
      };`)
  );

  server.registerTool(
    'foundry_eval',
    {
      description:
        'Run JavaScript inside the connected Foundry VTT world as the GM and return the result. ' +
        'The code is the body of an async function: use `await` freely and `return` the value you want. ' +
        'All Foundry globals are available (game, canvas, ui, CONFIG, foundry, Hooks, fromUuid, ChatMessage, Roll, ...). ' +
        'Documents and collections are serialized with toObject(); return only the fields you need, large results are truncated. ' +
        'console.log/warn/error output during the run is returned as `logs`. Errors raised later (hooks, workflows, timers) are not: ' +
        'read them with foundry_logs, passing the returned `logSeq` as `since`. This can change or delete anything a GM can.',
      inputSchema: z.object({
        code: z.string().describe('Body of an async function to run in the Foundry browser tab.'),
        timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('How long to wait for the result. Default 30000.'),
      }),
    },
    ({ code, timeoutMs }) => runTool(code, timeoutMs)
  );

  server.registerTool(
    'foundry_logs',
    {
      description:
        'Read warnings and errors captured in the Foundry GM tab: console.warn/error (which includes most UI notifications), ' +
        'uncaught exceptions and unhandled promise rejections, including ones raised after a foundry_eval call returned. ' +
        'Each entry has seq, time, level, source, `packages` (ids of the modules or systems on the stack, innermost first; ' +
        'the first is usually the one that logged it), `fromEval` (true when code sent through foundry_eval is on the stack), ' +
        'text, stack and a repeat count. ' +
        'The buffer is bounded and shared by all clients; it survives world reloads but not a hub restart. ' +
        'Works while Foundry is disconnected. Prefer `since` over `clear`, because clearing affects every client.',
      inputSchema: z.object({
        since: z.number().int().min(0).optional().describe('Only entries with seq greater than this. Use the logSeq returned by foundry_eval.'),
        level: z.enum(LEVELS).optional().describe('Minimum level. "info" (default) also includes connect/disconnect markers.'),
        package: z.string().optional().describe('Only entries with this module or system id on the stack, for example "midi-qol".'),
        contains: z.string().optional().describe('Case-insensitive text that must appear in the entry text or stack.'),
        limit: z.number().int().min(1).max(200).optional().describe('Return at most this many of the newest matches. Default 50.'),
        clear: z.boolean().optional().describe('Empty the whole buffer after this read.'),
      }),
    },
    (args) => ({ content: [{ type: 'text', text: asText(queryLogs(args)) }] })
  );

  return server;
}

// ------------------------------------------------------------------ HTTP + WS

const validateHost = localhostHostValidation(); // blocks DNS-rebinding requests

const http = createServer(async (req, res) => {
  try {
    if (!validateHost(req, res)) return;
    // MCP clients are not browsers. A request carrying Origin comes from a web
    // page, and no web page should be able to run code in Foundry through us.
    if (req.headers.origin) return res.writeHead(403).end('Browser origins are not allowed');
    if (new URL(req.url, 'http://localhost').pathname !== '/mcp') return res.writeHead(404).end('Not found');
    if (config.token && !tokenMatches(req.headers.authorization?.replace(/^Bearer\s+/i, ''))) {
      return res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('Missing or wrong bearer token');
    }
    // Stateless: a fresh MCP server and transport per request.
    const server = buildMcpServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('[foundry-mcp] request failed:', error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

const sockets = new WebSocketServer({
  server: http,
  path: '/foundry',
  maxPayload: 16 * 1024 * 1024,
  verifyClient: ({ origin }) => config.origins.includes(origin),
});
sockets.on('connection', onFoundryConnection);

// Drop a tab that vanished without closing (sleep, crash), so a new one can connect.
setInterval(() => {
  for (const ws of sockets.clients) {
    if (!ws.isAlive) ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000).unref();

http.listen(config.port, '127.0.0.1', () => {
  console.error(`[foundry-mcp] MCP endpoint  http://127.0.0.1:${config.port}/mcp${config.token ? '  (bearer token required)' : ''}`);
  console.error(`[foundry-mcp] Foundry module connects to ws://127.0.0.1:${config.port}/foundry from ${config.origins.join(', ')}`);
  console.error(`[foundry-mcp] Allowed worlds: ${config.worlds.join(', ') || '(none - add world ids to config.json)'}`);
});
