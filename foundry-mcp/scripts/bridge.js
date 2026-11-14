// Foundry MCP bridge. Runs in the GM's browser tab, dials out to the local MCP
// hub, evaluates the JavaScript it is sent, and forwards warnings and errors.
// All tool logic lives in the hub (server/index.js); this file should rarely
// need to change.

const MODULE_ID = 'foundry-mcp';
const PROTOCOL = 4; // bump together with MODULE_PROTOCOL in server/index.js
const SESSION = Math.random().toString(36).slice(2, 10); // identifies this page load
const EVAL_SOURCE = 'foundry-mcp-eval.js'; // name evaluated code gets in stack traces
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let socket = null; // set once the hub has accepted our hello
let capturing = true; // turned off for non-GM users at ready

// ------------------------------------------------------------------- settings

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'url', {
    name: 'MCP hub address',
    hint: 'WebSocket address of the Foundry MCP hub on this computer. Reload after changing.',
    scope: 'client',
    config: true,
    type: String,
    default: 'ws://127.0.0.1:30123/foundry',
  });
  game.settings.register(MODULE_ID, 'token', {
    name: 'Hub token (optional)',
    hint: 'The "token" value from the hub\'s config.json. Leave empty only if the hub runs without one. Stored in this browser. Reload after changing.',
    scope: 'client',
    config: true,
    type: String,
    default: '',
  });
});

Hooks.once('ready', () => {
  if (game.user.isGM) return connect();
  capturing = false; // players never connect, so keep nothing
  backlog.length = 0;
});

// ----------------------------------------------------------------- connection

function connect() {
  let url;
  try {
    url = new URL(game.settings.get(MODULE_ID, 'url'));
  } catch {
    url = null;
  }
  // Whoever answers at this address can run code as the GM, so it must be this computer.
  if (!url || !['ws:', 'wss:'].includes(url.protocol) || !LOOPBACK.includes(url.hostname)) {
    console.log(`${MODULE_ID} | not connecting: the hub address must be a ws:// address on 127.0.0.1 or localhost`);
    return;
  }
  const token = game.settings.get(MODULE_ID, 'token').trim();
  hubToken = token;
  const nonce = randomHex();
  const hello = { protocol: PROTOCOL, session: SESSION, world: game.world.id, core: game.version, system: game.system.id, nonce };
  // What both proofs cover: the nonces and what we said about ourselves, so a
  // relay in the middle cannot change the world id we reported.
  const binding = (hubNonce) => [nonce, hubNonce, hello.protocol, hello.world, hello.core, hello.system, hello.session].join('\n');
  let sessionKey = null; // with a token: set once the hub has proved it knows it; signs every command after that
  let received = 0; // commands seen, for the hub's signed sequence number
  const refuse = (reason) => ws.close(4003, reason);
  const ws = new WebSocket(url.href);
  ws.addEventListener('open', () => send({ hello }, ws));
  ws.addEventListener('message', async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.challenge && socket !== ws) {
      if (!token) return refuse('the hub requires a token; paste it into the "Hub token" module setting');
      if (!globalThis.crypto?.subtle) return refuse('token checks need a secure page (open Foundry via localhost or https)');
      const hubNonce = String(msg.challenge.nonce);
      if (msg.challenge.proof !== toHex(await hmac(token, `hub\n${binding(hubNonce)}`))) {
        return refuse('whatever answered at the hub address does not know the token');
      }
      sessionKey = await hmac(token, `session\n${binding(hubNonce)}`);
      return send({ proof: toHex(await hmac(token, `module\n${binding(hubNonce)}`)) }, ws);
    }
    if (msg.welcome && socket !== ws) {
      if (token && !sessionKey) return refuse('whatever answered at the hub address did not ask for the token');
      console.log(`${MODULE_ID} | connected to MCP hub`);
      socket = ws;
      for (const entry of backlog.splice(0)) send({ log: entry });
      return;
    }
    if (socket !== ws) return; // obey nothing until the handshake is complete
    if (msg.method !== 'eval' && msg.method !== 'cancel') return;
    if (sessionKey) {
      // Every command must carry the next sequence number and the hub's signature,
      // so nothing between us and the hub can insert, replay or alter one.
      const expected = ++received;
      const signed = `${expected}\n${msg.method}\n${msg.id}\n${msg.params?.code ?? ''}`;
      if (msg.seq !== expected || msg.mac !== toHex(await hmac(sessionKey, signed))) {
        return refuse('a command arrived that the hub did not sign');
      }
    }
    if (msg.method === 'cancel') return running.get(msg.id)?.abort();
    if (running.size >= MAX_RUNNING) {
      return send({ id: msg.id, ok: false, error: { message: `${MAX_RUNNING} evaluations are still running in Foundry; code that timed out keeps running. Reload the world to clear them.` }, logs: [] }, ws);
    }
    const controller = new AbortController();
    running.set(msg.id, controller);
    const reply = await evaluate(msg.params?.code, controller.signal);
    running.delete(msg.id);
    if (!send({ id: msg.id, ...reply }, ws)) {
      send({ id: msg.id, ok: false, error: { message: 'The result could not be sent back (too large or not serializable).' }, logs: [] }, ws);
    }
  });
  // The hub may not be running, or may restart: keep retrying quietly. Retry
  // slowly when the connection was refused (another GM tab, token trouble).
  ws.addEventListener('close', (event) => {
    if (socket === ws) {
      socket = null;
      for (const controller of running.values()) controller.abort(); // nobody is waiting for these any more
    }
    if (event.code >= 4000) console.log(`${MODULE_ID} | not connected: ${event.reason}`);
    setTimeout(connect, event.code >= 4000 ? 30_000 : 5000);
  });
}

const MAX_RUNNING = 16; // evaluations that have not finished, including ones the hub gave up on
const running = new Map(); // evaluation id -> AbortController
let hubToken = ''; // kept so it can be scrubbed from anything logged

const toHex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const randomHex = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

// HMAC-SHA256. `key` is the token text, or the bytes of a derived session key.
async function hmac(key, text) {
  const encode = (value) => new TextEncoder().encode(value);
  const cryptoKey = await crypto.subtle.importKey('raw', typeof key === 'string' ? encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encode(text));
}

function send(message, ws = socket) {
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- evaluation

// `signal` aborts if the hub gives up waiting. Nothing can force running code
// to stop; this only helps code that checks it.
async function evaluate(code, signal) {
  const logs = [];
  logs.dropped = 0;
  captures.add(logs);
  // Once the hub has given up on this call nobody will read its console output.
  signal.addEventListener('abort', () => captures.delete(logs));
  const withLogs = (reply) => (logs.dropped ? { ...reply, logs, logsDropped: logs.dropped } : { ...reply, logs });
  try {
    const result = await new AsyncFunction('signal', `${code}\n//# sourceURL=${EVAL_SOURCE}`)(signal);
    return withLogs({ ok: true, result: serialize(result) });
  } catch (error) {
    return withLogs({ ok: false, error: { name: error?.name, message: error?.message ?? String(error), stack: error?.stack } });
  } finally {
    captures.delete(logs);
  }
}

// ---------------------------------------------------------------- log capture
// Installed at import time so hook errors during world start-up are caught too.
// Only warnings and errors are kept; ordinary console.log chatter is not.

const captures = new Set(); // console output of evaluations in flight
const backlog = []; // entries waiting for a hub connection
const BACKLOG_LIMIT = 200;
const CAPTURE_LIMIT = 200; // console lines returned by one evaluation; the rest are counted
const RATE_LIMIT = 100; // entries per second; the rest are counted, not kept
let windowStart = 0;
let windowCount = 0;
let dropped = 0;

for (const level of ['log', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    try {
      // Other modules log during an evaluation too, so this output is redacted like the rest.
      for (const logs of captures) {
        if (logs.length >= CAPTURE_LIMIT) logs.dropped += 1;
        else logs.push({ level, text: redact(args.map((arg) => formatLogArg(arg, true)).join(' ').slice(0, 8000)) });
      }
      if (level !== 'log') {
        const error = args.find((arg) => arg instanceof Error);
        record(level, 'console', args.map((arg) => formatLogArg(arg, false)).join(' '), error?.stack ?? new Error().stack);
      }
    } catch {
      // Never let capture break the console.
    }
    original.apply(console, args);
  };
}

window.addEventListener('error', (event) => record('error', 'uncaught', event.message, event.error?.stack));
window.addEventListener('unhandledrejection', (event) =>
  record('error', 'rejection', String(event.reason?.message ?? event.reason), event.reason?.stack)
);

function record(level, source, text, stack) {
  if (!capturing) return;
  try {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > RATE_LIMIT) {
      dropped += 1;
      return;
    }
    const entry = { time: now, level, source, text: redact(String(text).slice(0, 2000)), ...describeStack(stack) };
    if (dropped) {
      entry.droppedBefore = dropped;
      dropped = 0;
    }
    if (socket && send({ log: entry })) return;
    backlog.push(entry);
    if (backlog.length > BACKLOG_LIMIT) backlog.shift();
  } catch {
    // Never let capture throw into the code that logged.
  }
}

// Work out whose code is involved: every module or system on the stack other
// than this one, innermost first, and whether code sent through the hub is.
// This is a heuristic: a module that logs an error on behalf of a macro or
// another module is still the one named first.
function describeStack(stack) {
  const frames = String(stack ?? '')
    .split('\n')
    .map((frame) => frame.trim().replaceAll(location.origin, ''))
    .filter((frame) => frame.startsWith('at ') || /@.*:\d+:\d+$/.test(frame)); // V8, or Firefox and Safari
  const own = `/modules/${MODULE_ID}/`;
  const packages = frames
    .map((frame) => !frame.includes(own) && frame.match(/\/(?:modules|systems)\/([^/]+)\//)?.[1])
    .filter(Boolean)
    .map(safeDecode);
  return {
    packages: [...new Set(packages)].slice(0, 10),
    fromEval: frames.some((frame) => frame.includes(EVAL_SOURCE)),
    stack: frames.filter((frame) => !frame.includes(`${own}scripts/bridge.js`) || frame.includes(EVAL_SOURCE)).slice(0, 8).map((frame) => redact(frame, false)),
  };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Best-effort removal of credentials before a log line leaves the browser.
// "token" alone is only treated as a credential in `token=...` or as a quoted
// key, because in a tabletop tool "Token: Goblin" is ordinary text.
function redact(text, opaque = true) {
  if (hubToken) text = text.split(hubToken).join('[redacted]');
  text = text
    // JSON-style: any quoted key that names a credential, such as {"token":"..."} or 'Authorization': '...'.
    .replace(/(["'][\w-]*(?:token|secret|password|passwd|api[-_]?key|authorization|cookie)[\w-]*["']\s*:\s*["'])[^"']+/gi, '$1[redacted]')
    // Header lines: the value runs to the end of the line ("Authorization: Basic ...", "Cookie: a=1; b=2").
    // Not applied to quoted keys, which the rule above handled without eating the rest of the object.
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)(\s*[:=]\s*)[^\n]+/gi, '$1$2[redacted]')
    .replace(/\b(bearer\s+)[\w.~+/=-]{8,}/gi, '$1[redacted]')
    // key=value and key: value, including prefixed names such as client_secret or openai_api_key.
    .replace(/\b([\w-]*(?:pass(?:word|wd)|secret|api[-_ ]?key)[\w-]*|(?:access|auth|api|refresh|session|cobalt|id|client|hub)[-_ ]?token|[\w-]*token(?==))(\s*["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, '$1$2[redacted]')
    .replace(/([?&](?:key|token|sig|signature|auth|code|secret|password)=)[^&\s"'#]+/gi, '$1[redacted]') // URL query strings
    .replace(/(:\/\/[^/@\s:]+:)[^@\s/]+@/g, '$1[redacted]@') // https://user:password@host
    .replace(/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+/g, '[redacted]');
  // Long opaque strings. Skipped for stack frames, where long function names are normal.
  return opaque ? text.replace(/\b[A-Za-z0-9_+=-]{40,}\b/g, '[redacted]') : text;
}
function formatLogArg(arg, withStack) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return withStack ? (arg.stack ?? arg.message) : `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(serialize(arg));
  } catch {
    return String(arg);
  }
}

// -------------------------------------------------------------- serialization
// Turn any value into plain JSON. Documents and data models become their
// toObject() source data; cycles, depth and size are capped so that returning
// something huge (a Token placeable, the canvas) cannot freeze the tab.

function serialize(value) {
  const ancestors = new WeakSet();
  let budget = 50_000; // values of any kind
  let chars = 400_000; // text across all strings; the hub cuts replies far below this anyway
  const walk = (v, depth) => {
    if (--budget < 0) return '[Truncated]';
    if (v === undefined) return null;
    if (typeof v === 'function') return `[Function ${v.name}]`;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') {
      const kept = v.length > chars ? `${v.slice(0, chars)}[Truncated ${v.length - chars} chars]` : v;
      chars = Math.max(0, chars - v.length);
      return kept;
    }
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Error) return walk({ name: v.name, message: v.message, stack: v.stack }, depth + 1);
    if (v instanceof Date) return v.toISOString();
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `[${v.constructor.name} ${v.byteLength} bytes]`;
    if (v instanceof Map) {
      // Checked before toObject(): a Foundry collection's toObject() would clone every document in it
      // before any limit applied. Walking it entry by entry stops when the budget does.
      const entries = {};
      for (const [key, item] of v) {
        if (budget <= 0) {
          entries['[Truncated]'] = `${v.size - Object.keys(entries).length} more entries omitted`;
          break;
        }
        entries[String(key)] = walk(item, depth + 1);
      }
      return entries;
    }
    if (typeof v.toObject === 'function') {
      try {
        v = v.toObject();
      } catch {
        return String(v);
      }
    } else if (v instanceof Set) v = [...v];
    if (v === null || typeof v !== 'object') return v;
    if (ancestors.has(v)) return '[Circular]';
    if (depth > 12) return '[MaxDepth]';
    ancestors.add(v);
    let out;
    // Stop visiting once the budget is spent, so a huge collection costs no more than a small one.
    if (Array.isArray(v)) {
      out = [];
      for (const item of v) {
        if (budget <= 0) {
          out.push(`[Truncated ${v.length - out.length} more items]`);
          break;
        }
        out.push(walk(item, depth + 1));
      }
    } else {
      out = {};
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (budget <= 0) {
          out['[Truncated]'] = 'more keys omitted';
          break;
        }
        out[key] = walk(v[key], depth + 1);
      }
    }
    ancestors.delete(v);
    return out;
  };
  return walk(value, 0);
}
