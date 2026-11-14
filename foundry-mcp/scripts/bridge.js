// Foundry MCP bridge. Runs in the GM's browser tab, dials out to the local MCP
// hub, evaluates the JavaScript it is sent, and forwards warnings and errors.
// All tool logic lives in the hub (server/index.js); this file should rarely
// need to change.

const MODULE_ID = 'foundry-mcp';
const PROTOCOL = 3; // bump together with MODULE_PROTOCOL in server/index.js
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
  const nonce = randomHex();
  let hubProven = false; // with a token set, the hub must prove it knows it before we obey it
  const refuse = (reason) => ws.close(4003, reason);
  const ws = new WebSocket(url.href);
  ws.addEventListener('open', () => {
    send({ hello: { protocol: PROTOCOL, session: SESSION, world: game.world.id, core: game.version, system: game.system.id, nonce } }, ws);
  });
  ws.addEventListener('message', async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.challenge && socket !== ws) {
      if (!token) return refuse('the hub requires a token; paste it into the "Hub token" module setting');
      if (!globalThis.crypto?.subtle) return refuse('token checks need a secure page (open Foundry via localhost or https)');
      const expected = await hmac(token, `hub:${nonce}:${msg.challenge.nonce}`);
      if (msg.challenge.proof !== expected) return refuse('whatever answered at the hub address does not know the token');
      hubProven = true;
      return send({ proof: await hmac(token, `module:${nonce}:${msg.challenge.nonce}`) }, ws);
    }
    if (msg.welcome && socket !== ws) {
      if (token && !hubProven) return refuse('whatever answered at the hub address did not ask for the token');
      console.log(`${MODULE_ID} | connected to MCP hub`);
      socket = ws;
      for (const entry of backlog.splice(0)) send({ log: entry });
      return;
    }
    if (socket !== ws) return; // obey nothing until the handshake is complete
    if (msg.method === 'cancel') return running.get(msg.id)?.abort();
    if (msg.method !== 'eval') return;
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
    if (socket === ws) socket = null;
    if (event.code >= 4000) console.log(`${MODULE_ID} | not connected: ${event.reason}`);
    setTimeout(connect, event.code >= 4000 ? 30_000 : 5000);
  });
}

const running = new Map(); // evaluation id -> AbortController

function randomHex() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, text) {
  const encode = (value) => new TextEncoder().encode(value);
  const cryptoKey = await crypto.subtle.importKey('raw', encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encode(text));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
  captures.add(logs);
  try {
    const result = await new AsyncFunction('signal', `${code}\n//# sourceURL=${EVAL_SOURCE}`)(signal);
    return { ok: true, result: serialize(result), logs };
  } catch (error) {
    return { ok: false, error: { name: error?.name, message: error?.message ?? String(error), stack: error?.stack }, logs };
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
const RATE_LIMIT = 100; // entries per second; the rest are counted, not kept
let windowStart = 0;
let windowCount = 0;
let dropped = 0;

for (const level of ['log', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    try {
      // Other modules log during an evaluation too, so this output is redacted like the rest.
      for (const logs of captures) logs.push({ level, text: redact(args.map((arg) => formatLogArg(arg, true)).join(' ').slice(0, 8000)) });
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
    .filter((frame) => frame.startsWith('at '));
  const own = `/modules/${MODULE_ID}/`;
  const packages = frames
    .map((frame) => !frame.includes(own) && frame.match(/\/(?:modules|systems)\/([^/]+)\//)?.[1])
    .filter(Boolean)
    .map(decodeURIComponent);
  return {
    packages: [...new Set(packages)].slice(0, 10),
    fromEval: frames.some((frame) => frame.includes(EVAL_SOURCE)),
    stack: frames.filter((frame) => !frame.includes(`${own}scripts/bridge.js`) || frame.includes(EVAL_SOURCE)).slice(0, 8).map(redact),
  };
}

// Best-effort removal of credentials before a log line leaves the browser.
function redact(text) {
  return text
    .replace(/\b(bearer\s+)[\w.~+/=-]{8,}/gi, '$1[redacted]') // before the next rule, which would stop at "Bearer"
    .replace(/\b(pass(?:word|wd)|secret|api[-_ ]?key|cookie|authorization|(?:access|auth|api|refresh|session|cobalt)[-_ ]?token)(\s*["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, '$1$2[redacted]')
    .replace(/([?&](?:key|token|sig|signature|auth|code|secret|password)=)[^&\s"'#]+/gi, '$1[redacted]') // URL query strings
    .replace(/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_+=-]{40,}\b/g, '[redacted]');
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
  let budget = 50_000;
  const walk = (v, depth) => {
    if (v === undefined) return null;
    if (typeof v === 'function') return `[Function ${v.name}]`;
    if (typeof v === 'bigint') return v.toString();
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    if (v instanceof Date) return v.toISOString();
    if (typeof v.toObject === 'function') {
      try {
        v = v.toObject();
      } catch {
        return String(v);
      }
    } else if (v instanceof Map) v = Object.fromEntries(v);
    else if (v instanceof Set) v = [...v];
    if (v === null || typeof v !== 'object') return v;
    if (ancestors.has(v)) return '[Circular]';
    if (depth > 12) return '[MaxDepth]';
    if (--budget < 0) return '[Truncated]';
    ancestors.add(v);
    let out;
    if (Array.isArray(v)) out = v.map((item) => walk(item, depth + 1));
    else {
      out = {};
      for (const key of Object.keys(v)) out[key] = walk(v[key], depth + 1);
    }
    ancestors.delete(v);
    return out;
  };
  return walk(value, 0);
}
