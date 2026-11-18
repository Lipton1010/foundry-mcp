// Foundry MCP bridge. Runs in the GM's browser tab, dials out to the local MCP
// hub, evaluates the JavaScript it is sent, and forwards warnings and errors.
// All tool logic lives in the hub (server/index.js); this file should rarely
// need to change.

const MODULE_ID = 'foundry-mcp';
const PROTOCOL = 6; // bump together with MODULE_PROTOCOL in server/index.js
const SESSION = Math.random().toString(36).slice(2, 10); // identifies this page load
const EVAL_SOURCE = 'foundry-mcp-eval.js'; // name a caller's code gets in stack traces
const TOOL_SOURCE = 'foundry-mcp-tool.js'; // and the hub's own fixed tools
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
  // A new setting, not the 0.6 "token" one: that held the client token, which must not be used for pairing.
  game.settings.register(MODULE_ID, 'pairingToken', {
    name: 'Hub pairing token',
    hint: 'The "moduleToken" value from the hub\'s config.json. It lets this tab and the hub prove themselves to each other. Stored in this browser. Reload after changing.',
    scope: 'client',
    config: true,
    type: String,
    default: '',
  });
  // Without a pairing token, whatever answers at the hub address is trusted to run code as the GM. That has to be a choice.
  game.settings.register(MODULE_ID, 'allowNoToken', {
    name: 'Connect without a pairing token',
    hint: 'Only for a hub whose "moduleToken" is "". This tab then cannot tell the hub from another program on this computer. Reload after changing.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
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
  const token = game.settings.get(MODULE_ID, 'pairingToken').trim();
  hubToken = token;
  if (!token && !game.settings.get(MODULE_ID, 'allowNoToken')) {
    console.log(`${MODULE_ID} | not connecting: paste the hub's "moduleToken" into the "Hub pairing token" setting, then reload`);
    return;
  }
  const nonce = randomHex();
  const hello = { protocol: PROTOCOL, session: SESSION, world: game.world.id, core: game.version, system: game.system.id, nonce };
  // What both proofs cover: the nonces and what we said about ourselves, so a
  // relay in the middle cannot change the world id we reported.
  const binding = (hubNonce) => [nonce, hubNonce, hello.protocol, hello.world, hello.core, hello.system, hello.session].join('\n');
  let sessionKey = null; // with a token: set once the hub has proved it knows it; signs every command after that
  let received = 0; // commands seen, for the hub's signed sequence number
  let refused = false;
  let ws;
  const refuse = (reason) => {
    refused = true; // nothing queued behind this message may run
    if (socket === ws) socket = null;
    ws.close(4003, reason);
  };
  try {
    ws = new WebSocket(url.href);
  } catch (error) {
    // Some browsers refuse outright, for example a secure page opening an insecure socket.
    console.log(`${MODULE_ID} | not connecting: the browser would not open ${url.href} (${error.message})`);
    return;
  }
  ws.addEventListener('open', () => send({ hello }, ws));

  // Messages are handled strictly one after another. Checking a signature is
  // asynchronous, and without the queue a short "cancel" could overtake the
  // "eval" it refers to. Only the checking is queued: evaluations still run side by side.
  let queue = Promise.resolve();
  ws.addEventListener('message', (event) => {
    queue = queue.then(() => handle(event.data)).catch(() => refuse('a message from the hub could not be handled'));
  });

  async function handle(data) {
    if (refused) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.challenge && socket !== ws) {
      if (!token) return refuse('the hub requires a token; paste it into the "Hub token" module setting');
      if (!globalThis.crypto?.subtle) return refuse('token checks need a secure page (open Foundry via localhost or https)');
      const hubNonce = String(msg.challenge.nonce);
      const proofOk = msg.challenge.proof === toHex(await hmac(token, `hub\n${binding(hubNonce)}`));
      if (refused) return; // the connection went away while the proof was being checked
      if (!proofOk) return refuse('whatever answered at the hub address does not know the token');
      sessionKey = await hmac(token, `session\n${binding(hubNonce)}`);
      const proof = toHex(await hmac(token, `module\n${binding(hubNonce)}`));
      return refused ? undefined : send({ proof }, ws);
    }
    if (msg.welcome && socket !== ws) {
      if (token && !sessionKey) return refuse('whatever answered at the hub address did not ask for the token');
      console.log(`${MODULE_ID} | connected to MCP hub`);
      socket = ws;
      // Entries captured during start-up were redacted before the token setting could be read; scrub them again.
      for (const entry of backlog.splice(0)) send({ log: { ...entry, text: redact(entry.text), stack: entry.stack.map((frame) => redact(frame, false)) } });
      return;
    }
    if (socket !== ws) return; // obey nothing until the handshake is complete
    if (msg.method !== 'eval' && msg.method !== 'cancel') return;
    const code = msg.method === 'eval' ? msg.params?.code : '';
    const source = msg.method === 'eval' ? msg.params?.source : '';
    // Exact shapes only: an id is a UUID, code is text, and the source is one of two words. Anything else is not from our hub.
    if (typeof msg.id !== 'string' || !UUID.test(msg.id) || typeof code !== 'string' || (msg.method === 'eval' && source !== 'eval' && source !== 'tool')) {
      return refuse('a malformed command arrived');
    }
    if (sessionKey) {
      // Every command must carry the next sequence number and the hub's signature,
      // so nothing between us and the hub can insert, replay, reorder or alter one.
      // The signed text is a JSON array, so no field can borrow characters from its neighbour.
      const expected = ++received;
      const signatureOk = msg.seq === expected && msg.mac === toHex(await hmac(sessionKey, JSON.stringify([expected, msg.method, msg.id, code, source])));
      if (refused) return; // the connection closed while the signature was being checked: do not start anything
      if (!signatureOk) return refuse('a command arrived that the hub did not sign');
    }
    if (msg.method === 'cancel') return running.get(msg.id)?.abort();
    if (running.size >= MAX_RUNNING) {
      return send({ id: msg.id, ok: false, error: { message: `${MAX_RUNNING} evaluations are still running in Foundry; code that timed out keeps running. Reload the world to clear them.` }, logs: [] }, ws);
    }
    const controller = new AbortController();
    running.set(msg.id, controller);
    // Not awaited: the queue moves on while this evaluation runs.
    evaluate(code, controller.signal, source)
      .catch(() => ({ ok: false, error: { message: 'The evaluation failed in a way that could not be reported.' }, logs: [] }))
      .then((reply) => {
        if (!send({ id: msg.id, ...reply }, ws)) {
          send({ id: msg.id, ok: false, error: { message: 'The result could not be sent back (too large or not serializable).' }, logs: [] }, ws);
        }
      })
      .finally(() => running.delete(msg.id)); // whatever happened, the slot is free once the code has finished
  }

  // The hub may not be running, or may restart: keep retrying quietly. Retry
  // slowly when the connection was refused (another GM tab, token trouble).
  ws.addEventListener('close', (event) => {
    refused = true; // anything still queued for this connection must not run
    if (socket === ws) socket = null;
    for (const controller of running.values()) controller.abort(); // nobody is waiting for these any more
    if (event.code >= 4000) console.log(`${MODULE_ID} | not connected: ${event.reason}`);
    setTimeout(connect, event.code >= 4000 ? 30_000 : 5000);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
async function evaluate(code, signal, source) {
  const logs = [];
  logs.dropped = 0;
  captures.add(logs);
  // Once the hub has given up on this call nobody will read its console output.
  signal.addEventListener('abort', () => captures.delete(logs));
  const withLogs = (reply) => (logs.dropped ? { ...reply, logs, logsDropped: logs.dropped } : { ...reply, logs });
  try {
    const result = await new AsyncFunction('signal', `${code}\n//# sourceURL=${source === 'eval' ? EVAL_SOURCE : TOOL_SOURCE}`)(signal);
    let serialized;
    try {
      serialized = serialize(result);
    } catch (error) {
      serialized = `[The result could not be serialized: ${error?.message}]`;
    }
    return withLogs({ ok: true, result: serialized });
  } catch (error) {
    // A thrown value can be anything, including an object whose properties throw when read.
    const read = (pick, max) => {
      try {
        const value = pick();
        return value === undefined ? undefined : String(value).slice(0, max);
      } catch {
        return '[Unreadable]';
      }
    };
    return withLogs({ ok: false, error: { name: read(() => error?.name, 200), message: read(() => error?.message ?? error, 10_000), stack: read(() => error?.stack, 10_000) } });
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
const REDACT_SLACK = 512; // extra text examined past a cut, so a secret straddling it is still recognised
const CAPTURE_LIMIT = 200; // console lines returned by one evaluation; the rest are counted
const RATE_LIMIT = 100; // entries per second; the rest are counted, not kept
let windowStart = 0;
let windowCount = 0;
let dropped = 0;

for (const level of ['log', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    try {
      // Turning the arguments into text is the expensive part (a logged document is walked and
      // serialized), so it happens at most once per call, however many evaluations are listening,
      // and not at all when nobody will keep the line.
      let parts;
      const text = (withStack) => {
        parts ??= args.map((arg) => (arg instanceof Error ? arg : formatLogArg(arg)));
        return parts.map((part) => (part instanceof Error ? (withStack ? (part.stack ?? part.message) : `${part.name}: ${part.message}`) : part)).join(' ');
      };
      // Other modules log during an evaluation too, so this output is redacted like the rest.
      let line;
      for (const logs of captures) {
        if (logs.length >= CAPTURE_LIMIT) logs.dropped += 1;
        else logs.push((line ??= { level, text: redact(text(true).slice(0, 8000 + REDACT_SLACK)).slice(0, 8000) }));
      }
      if (level !== 'log') {
        const error = args.find((arg) => arg instanceof Error);
        record(level, 'console', () => text(false), error?.stack ?? new Error().stack);
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
    if (typeof text === 'function') text = text(); // console lines are only formatted once they are known to be kept
    const entry = { time: now, level, source, text: redact(String(text).slice(0, 2000 + REDACT_SLACK)).slice(0, 2000), ...describeStack(stack) };
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
    stack: frames.filter((frame) => !frame.includes(`${own}scripts/bridge.js`) || frame.includes(EVAL_SOURCE)).slice(0, 8).map((frame) => redact(frame.slice(0, 300), false)),
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
function redact(text, opaque = true) {
  if (hubToken) text = text.split(hubToken).join('[redacted]');
  text = text
    // Header lines: the value runs to the end of the line ("Authorization: Basic ...", "Cookie: a=1; b=2").
    // A quoted key ("Authorization":"...") is left for the next rule, which keeps the rest of the object.
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)(\s*[:=]\s*)[^\n]+/gi, '$1$2[redacted]')
    .replace(/\b(bearer\s+)[\w.~+/=-]{8,}/gi, '$1[redacted]')
    // key=value, key: value and "key":"value". The key is one bounded word ending in a credential-like
    // word and is judged by name afterwards; a quoted value is taken up to its own closing quote,
    // escapes included.
    // A quoted value runs to its closing quote, across line breaks; one whose closing quote was cut off with the end
    // of a long line runs to the end of the text.
    .replace(/([\w-]{0,74}(?:password|passwd|key|token|secret|authorization|cookie))(\s*(["'])?\s*[:=]\s*)("(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\s"',;&}]+)/gi, (match, key, separator, keyQuote, value) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      const closed = quote !== '' && value.length > 1 && value.endsWith(quote) && !value.endsWith(`\\${quote}`);
      if (!isCredentialKey(key, Boolean(keyQuote) || separator.includes('='), quote ? value.slice(1, closed ? -1 : undefined) : value)) return match;
      return `${key}${separator}${quote}[redacted]${closed ? quote : ''}`;
    })
    .replace(/([?&](?:key|token|sig|signature|auth|code|secret|password)=)[^&\s"'#]+/gi, '$1[redacted]') // URL query strings
    // scheme://user:password@host. The user may be empty (redis://:password@host), and the password
    // runs to the LAST "@" before the path, because a password may itself contain one.
    .replace(/(:\/\/[^/@\s:"']*:)[^\s/?#"']+@/g, '$1[redacted]@')
    .replace(/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+/g, '[redacted]')
    // Keys recognisable by their published prefix: AWS access key ids, Stripe, GitHub and Slack tokens.
    .replace(/\b(?:A[KS]IA[0-9A-Z]{16}|[spr]k_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abeprs]-[\w-]{10,})\b/g, '[redacted]');
  // Long opaque strings such as base64 or hex keys, including trailing "=" padding. Only runs that mix
  // letters and digits count, so long names and divider lines survive. Skipped for stack frames.
  if (!opaque) return text;
  return text.replace(/(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{40,}(?![A-Za-z0-9_+=-])/g, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? '[redacted]' : run));
}

// Does this key name a credential? It must END in the credential word, so a Foundry "tokenId" or
// "tokenName" is left alone. "token" and "secret" are also everyday words in a tabletop tool
// ("Token: Goblin", "Secret: a hidden door"), so on their own they only count in `key=value`
// or quoted-key form (`assignment`); with a prefix (access_token, client_secret) they always count.
// Written as plain `token: value`, the value decides: one that looks machine-made (six or more
// characters with a digit, or twelve or more of anything) is taken for a credential, a short word is not.
function isCredentialKey(key, assignment, value) {
  const name = key.toLowerCase().replace(/(key|token|secret|password)s$/, '$1'); // a list of them: apiKeys, tokens
  if (/(?:password|passwd|api[-_]?key|secret[-_]?key|private[-_]?key|authorization|cookie)$/.test(name)) return true;
  if (/(?:token|secret)$/.test(name)) return assignment || name.length > 6 || value.length >= 12 || (value.length >= 6 && /\d/.test(value));
  return false;
}

// A console line keeps at most 8000 characters, so its arguments get a far smaller allowance than
// a result does: logging a huge object in a loop must not stall the tab.
const LOG_ARG_LIMITS = { budget: 5000, chars: 20_000 };

function formatLogArg(arg) {
  if (typeof arg === 'string') return arg;
  try {
    // Values under credential-like keys are withheld while the object becomes text, before any of it can be cut off.
    return JSON.stringify(serialize(arg, { ...LOG_ARG_LIMITS, redactKeys: true }));
  } catch {
    return String(arg);
  }
}

// -------------------------------------------------------------- serialization
// Turn any value into plain JSON. Documents and data models become their
// toObject() source data. Every path is subject to the same limits (values,
// text including keys, depth, cycles), so returning something huge (a Token
// placeable, the canvas, a whole collection) cannot freeze the tab.

// `budget` counts values of any kind; `chars` counts text across all strings and keys (the hub
// cuts replies far below the default anyway).
function serialize(value, { budget = 50_000, chars = 400_000, redactKeys = false } = {}) {
  const ancestors = new WeakSet();
  // Text, or a list, under a credential-like key ("apiKeys": [...] too) is withheld whole.
  const hidden = (key, item) => redactKeys && (typeof item === 'string' || Array.isArray(item)) && isCredentialKey(String(key), true, typeof item === 'string' ? item : 'a list of values');
  const text = (v) => {
    const kept = v.length > chars ? `${v.slice(0, chars)}[Truncated ${v.length - chars} chars]` : v;
    chars = Math.max(0, chars - v.length);
    return kept;
  };
  const walk = (v, depth) => {
    if (--budget < 0) return '[Truncated]';
    if (v === undefined) return null;
    if (typeof v === 'function') return `[Function ${text(String(v.name))}]`;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return text(v);
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `[${v.constructor.name} ${v.byteLength} bytes]`;
    if (ancestors.has(v)) return '[Circular]';
    if (depth > 12) return '[MaxDepth]';
    ancestors.add(v);
    try {
      if (v instanceof Error) return walk({ name: v.name, message: v.message, stack: v.stack }, depth + 1);
      // Maps (which include Foundry collections) and Sets are walked entry by entry and stop with the
      // budget. A collection's own toObject() would clone every document in it before any limit applied.
      if (v instanceof Map) {
        const entries = Object.create(null); // no prototype, so a key named "__proto__" is kept like any other
        let seen = 0;
        // Map's own entries(): a Foundry Collection is a Map whose default iterator yields values only.
        for (const [key, item] of Map.prototype.entries.call(v)) {
          if (budget <= 0 || chars <= 0) {
            entries['[Truncated]'] = `${v.size - seen} more entries omitted`;
            break;
          }
          entries[text(String(key))] = hidden(key, item) ? '[redacted]' : walk(item, depth + 1);
          seen += 1;
        }
        return entries;
      }
      if (v instanceof Set) {
        const items = [];
        for (const item of v) {
          if (budget <= 0) {
            items.push(`[Truncated ${v.size - items.length} more items]`);
            break;
          }
          items.push(walk(item, depth + 1));
        }
        return items;
      }
      if (typeof v.toObject === 'function') {
        let source;
        try {
          source = v.toObject();
        } catch {
          return text(String(v));
        }
        return source === v ? '[Circular]' : walk(source, depth + 1); // whatever it returned gets the same limits
      }
      // Stop visiting once the budget is spent, so a huge collection costs no more than a small one.
      if (Array.isArray(v)) {
        const out = [];
        for (const item of v) {
          if (budget <= 0) {
            out.push(`[Truncated ${v.length - out.length} more items]`);
            break;
          }
          out.push(walk(item, depth + 1));
        }
        return out;
      }
      const out = Object.create(null);
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (budget <= 0 || chars <= 0) {
          out['[Truncated]'] = 'more keys omitted';
          break;
        }
        let item;
        try {
          item = v[key];
        } catch {
          item = '[Unreadable]'; // a getter that throws must not fail the whole reply
        }
        out[text(key)] = hidden(key, item) ? '[redacted]' : walk(item, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  return walk(value, 0);
}