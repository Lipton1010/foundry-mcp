// End-to-end checks without Foundry: starts hubs, loads the real module script
// against stubbed Foundry globals, and calls the tools over MCP HTTP.
// Everything here is simulated; see README "Verifying against a real world".
// Run with: npm test   (takes about 45 s because it waits out real reconnects)

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setMaxListeners } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const PORT = 30199; // no token, small log buffer
const TOKEN_PORT = 30198; // token required
const BARE_PORT = 30197; // no token, eval and read tools disabled, nothing connected: stands in for an impostor hub
const READ_PORT = 30192; // no token, eval disabled, read tools left on
const FRESH_PORT = 30196; // a config copied from the example: no token, no worlds, world-readable
const FAULT_PORT = 30194; // no token; its sockets can be made to fail on send (test-fixtures/fault-send.mjs)
const FAKE_PORT = 30195; // a hand-rolled hub that knows the token but sends an unsigned command
const TOKEN = 'correct-horse-battery';
const ORIGIN = 'http://localhost:30000';
const tmp = mkdtempSync(join(tmpdir(), 'foundry-mcp-test-'));
const freshConfig = join(tmp, 'config.json');
writeFileSync(freshConfig, '{ "worlds": [] }');
chmodSync(freshConfig, 0o644);

function startHub(env, nodeArgs = []) {
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith('FOUNDRY_MCP_')) delete base[key];
  return spawn(process.execPath, [...nodeArgs, 'index.js'], {
    cwd: import.meta.dirname,
    // Point at a config file that does not exist so a local config.json is never read.
    env: { ...base, FOUNDRY_MCP_CONFIG: join(tmp, 'none.json'), FOUNDRY_MCP_WORLDS: 'test-world', ...env },
    stdio: 'inherit',
  });
}
const hubs = [
  startHub({ FOUNDRY_MCP_PORT: PORT, FOUNDRY_MCP_TOKEN: '', FOUNDRY_MCP_LOG_LIMIT: 60 }),
  startHub({ FOUNDRY_MCP_PORT: TOKEN_PORT, FOUNDRY_MCP_TOKEN: `${TOKEN} ` }), // trailing space, as a shell can add
  startHub({ FOUNDRY_MCP_PORT: BARE_PORT, FOUNDRY_MCP_TOKEN: '', FOUNDRY_MCP_ALLOW_EVAL: 'false', FOUNDRY_MCP_ALLOW_READ: 'false', FOUNDRY_MCP_ORIGINS: 'http://LOCALHOST:30000/' }), // origin as a person might type it
  startHub({ FOUNDRY_MCP_PORT: READ_PORT, FOUNDRY_MCP_TOKEN: '', FOUNDRY_MCP_ALLOW_EVAL: 'false' }),
  startHub({ FOUNDRY_MCP_PORT: FRESH_PORT, FOUNDRY_MCP_CONFIG: freshConfig, FOUNDRY_MCP_WORLDS: '' }),
  startHub({ FOUNDRY_MCP_PORT: FAULT_PORT, FOUNDRY_MCP_TOKEN: '' }, ['--import', new URL('./test-fixtures/fault-send.mjs', import.meta.url).href]),
];

async function mcp(method, params, { headers = {}, port = PORT, httpMethod = 'POST' } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: httpMethod,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: httpMethod === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) : undefined,
  });
  const text = await response.text();
  if (!response.ok) return { status: response.status, text };
  // The reply is either plain JSON or a one-event SSE stream.
  const json = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data:')).slice(5);
  return JSON.parse(json);
}
const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` }, port: TOKEN_PORT });
const callTool = async (name, args = {}, options) => (await mcp('tools/call', { name, arguments: args }, options)).result;
const payload = (result) => JSON.parse(result.content[0].text);
const evalCode = async (code, extra = {}, options) => payload(await callTool('foundry_eval', { code, ...extra }, options));
const getLogs = async (args = {}) => payload(await callTool('foundry_logs', args));
const getLogsFrom = async (options) => payload(await callTool('foundry_logs', { limit: 1 }, options));
const toolNames = async (options) => (await mcp('tools/list', {}, options)).result.tools.map((t) => t.name);

// --- Stub the slice of Foundry and the browser the module touches.
const hooks = {};
const settings = {
  'foundry-mcp.url': 'ws://evil.example:30199/foundry', 'foundry-mcp.token': '',
  'core.defaultToken': { displayName: 20 }, 'weather.apiKey': 'sk-weather-123', 'weather.units': 'metric',
};
// What the read-only tools look at. A Foundry Collection is a Map that iterates its values.
class Collection extends Map {
  [Symbol.iterator]() {
    return this.values();
  }
}
const goblin = {
  id: 'g1', uuid: 'Actor.g1', documentName: 'Actor', name: 'Goblin Boss', type: 'npc', folder: { id: 'f1' },
  toObject: () => ({ _id: 'g1', name: 'Goblin Boss', system: { attributes: { hp: { value: 21, max: 21 } } }, items: [{ name: 'Scimitar' }] }),
};
// A world setting as Foundry stores it: a document holding the raw value.
const storedSetting = { id: 's1', uuid: 'Setting.s1', documentName: 'Setting', name: null, toObject: () => ({ key: 'weather.apiKey', value: '"sk-weather-123"' }) };
const registered = new Map(
  [
    ['foundry-mcp', 'token', 'client', 'Hub token'],
    ['core', 'defaultToken', 'world', 'SETTINGS.DefaultToken'],
    ['weather', 'apiKey', 'world', 'API key'],
    ['weather', 'units', 'world', 'Units'],
    ['weather', 'broken', 'world', undefined],
  ].map(([namespace, key, scope, name]) => [`${namespace}.${key}`, { namespace, key, scope, name }])
);
const actor = { name: 'Test Actor', flags: {}, toObject() { return { name: this.name, flags: this.flags }; } };
globalThis.Hooks = { once: (name, fn) => (hooks[name] = fn) };
globalThis.game = {
  settings: {
    register() {},
    settings: registered,
    get: (module, key) => {
      if (key === 'broken') throw new Error('weather.broken is not a registered setting');
      return settings[`${module}.${key}`];
    },
  },
  i18n: { localize: (text) => text.replace('SETTINGS.DefaultToken', 'Default Token') },
  collections: new Collection([
    ['Actor', new Collection([['g1', goblin], ['g2', { id: 'g2', uuid: 'Actor.g2', name: 'Goblin', type: 'npc', folder: null }]])],
    ['ChatMessage', new Collection([['c1', { id: 'c1', uuid: 'ChatMessage.c1' }]])],
    ['Setting', new Collection([['s1', storedSetting]])],
  ]),
  packs: new Collection([
    ['sys.monsters', {
      collection: 'sys.monsters', documentName: 'Actor', metadata: { label: 'Monsters' },
      index: new Collection([['m1', { _id: 'm1', name: 'Aberrant Tyrant', type: 'npc', uuid: 'Compendium.sys.monsters.Actor.m1' }], ['m2', { _id: 'm2', name: 'Zombie' }]]),
      getUuid: (id) => `Compendium.sys.monsters.Actor.${id}`,
    }],
  ]),
  user: { isGM: true, name: 'Gamemaster' },
  world: { id: 'test-world', title: 'Test World' },
  system: { id: 'some-system', title: 'Some System', version: '1.0.0' },
  version: '14.370',
  actors: Object.assign(new Map([['a1', actor]]), { getName: () => actor }),
  items: new Map(), scenes: Object.assign(new Map(), { active: null }), macros: new Map(), journal: new Map(),
  modules: [{ id: 'foundry-mcp', version: '0.5.0', active: true }],
};
globalThis.fromUuid = async (uuid) => ({ 'Actor.g1': goblin, 'Setting.s1': storedSetting })[uuid] ?? null;
globalThis.canvas = { scene: null };
globalThis.window = new EventTarget();
setMaxListeners(50, globalThis.window); // every module copy a check loads adds its listeners
globalThis.location = { origin: ORIGIN };
// The browser's WebSocket, played by the `ws` client (Node 20 has none built in),
// which also lets the test set the Origin header a browser would send.
const moduleSockets = [];
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(url) {
    super(url, { headers: { origin: ORIGIN } });
    moduleSockets.push(this);
    this.addEventListener('close', (event) => (this.closeCode = event.code));
  }
};
// Loads another copy of the real module script, as a second browser tab would.
let copies = 0;
async function startModule(url, token, beforeReady) {
  settings['foundry-mcp.url'] = url;
  settings['foundry-mcp.token'] = token;
  // A real second instance needs a second file: Node reuses the module for a URL that differs only by query.
  const copy = join(tmp, `bridge-${++copies}.mjs`);
  copyFileSync(new URL('../foundry-mcp/scripts/bridge.js', import.meta.url), copy);
  const registered = hooks.ready;
  await import(pathToFileURL(copy).href);
  assert.notEqual(hooks.ready, registered, 'a separate module instance was loaded');
  hooks.init();
  beforeReady?.();
  hooks.ready();
  await sleep(600);
}
// A hand-rolled socket for playing a second tab, a hostile page, or a client with the wrong token.
// `firstMessage` replaces the hello; `claimedWorld` is what a relay would rewrite the hello to say.
// `reported` overrides what the module says about itself (and proves); `relayed` what reaches the hub instead.
const sign = (key, text) => createHmac('sha256', key).update(text).digest();
const bindingOf = (hello, hubNonce) => [hello.nonce, hubNonce, hello.protocol, hello.world, hello.core, hello.system, hello.session].join('\n');
function rawSocket(port, origin, token, { firstMessage, claimedWorld, reported = {}, relayed = {} } = {}) {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/foundry`, { headers: { origin } });
  const hello = { protocol: 5, session: 's', world: 'test-world', core: '14', system: 'y', nonce: 'abc', ...reported };
  const sent = { ...hello, world: claimedWorld ?? hello.world, ...relayed };
  return new Promise((resolve) => {
    ws.addEventListener('open', () => ws.send(firstMessage ?? JSON.stringify({ hello: sent })));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.challenge) {
        const expected = sign(TOKEN, `hub\n${bindingOf(sent, msg.challenge.nonce)}`).toString('hex');
        assert.equal(msg.challenge.proof, expected, 'the hub proves it knows the token');
        ws.send(JSON.stringify({ proof: sign(token ?? '', `module\n${bindingOf(hello, msg.challenge.nonce)}`).toString('hex') }));
      } else resolve({ ws, outcome: msg.welcome ? 'welcomed' : 'other' });
    });
    ws.addEventListener('close', (event) => resolve({ outcome: 'closed', code: event.code }));
    ws.addEventListener('error', () => resolve({ outcome: 'rejected' }));
  });
}
const fixture = await import('./test-fixtures/modules/fake-automation/scripts/workflow.js');
globalThis.fakeAutomation = fixture;

// Wait for something to become true instead of guessing how long it takes.
const until = async (probe, what) => {
  for (let tries = 0; tries < 200; tries++) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}`);
};

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

try {
  // Wait until every hub answers instead of guessing how long start-up takes.
  for (const port of [PORT, TOKEN_PORT, BARE_PORT, READ_PORT, FRESH_PORT, FAULT_PORT]) {
    for (let tries = 0; ; tries++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch (error) {
        if (tries > 100) throw new Error(`hub on port ${port} did not start`, { cause: error });
        await sleep(100);
      }
    }
  }
  await import('../foundry-mcp/scripts/bridge.js');
  hooks.init();

  // ------------------------------------------------------------ basic tools
  await check('tools refuse politely while Foundry is not connected', async () => {
    const result = await callTool('foundry_status');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not connected/);
  });

  await check('module refuses a hub address that is not on this computer', async () => {
    hooks.ready();
    await sleep(300);
    assert.equal(moduleSockets.length, 0);
  });

  await check('an error raised before the hub connection is delivered after it', async () => {
    console.error('early start-up failure');
    settings['foundry-mcp.url'] = `ws://127.0.0.1:${PORT}/foundry`;
    hooks.ready();
    await sleep(500);
    const logs = await getLogs({ contains: 'early start-up' });
    assert.equal(logs.connected, true);
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0].level, 'error');
  });

  await check('lists the eight tools', async () => {
    assert.deepEqual(await toolNames(), ['foundry_status', 'foundry_documents', 'foundry_document', 'foundry_settings', 'foundry_eval', 'foundry_dice', 'foundry_changes', 'foundry_logs']);
  });

  await check('status reports world and system without assuming dnd5e', async () => {
    const status = payload(await callTool('foundry_status')).result;
    assert.equal(status.world, 'test-world');
    assert.equal(status.system, 'some-system');
  });

  // --------------------------------------------------------- read-only tools
  await check('documents are listed by collection and compendium, searched by name, and read by UUID', async () => {
    const read = async (name, args) => payload(await callTool(name, args)).result;
    assert.deepEqual(await read('foundry_documents', {}), {
      collections: { Actor: 2, ChatMessage: 1 },
      packs: [{ id: 'sys.monsters', label: 'Monsters', documentName: 'Actor', size: 2 }],
    });
    assert.deepEqual(await read('foundry_documents', { type: 'Actor', name: 'BOSS' }), {
      type: 'Actor', total: 1, documents: [{ id: 'g1', name: 'Goblin Boss', type: 'npc', folder: 'f1', uuid: 'Actor.g1' }],
    });
    const limited = await read('foundry_documents', { type: 'Actor', limit: 1 });
    assert.equal(limited.total, 2);
    assert.equal(limited.documents.length, 1);
    // A document with no name (a chat message) is listed, and matches no name search.
    assert.deepEqual((await read('foundry_documents', { type: 'ChatMessage' })).documents, [{ id: 'c1', name: null, type: null, folder: null, uuid: 'ChatMessage.c1' }]);
    assert.equal((await read('foundry_documents', { type: 'ChatMessage', name: 'x' })).total, 0);
    assert.deepEqual((await read('foundry_documents', { pack: 'sys.monsters' })).documents, [
      { id: 'm1', name: 'Aberrant Tyrant', type: 'npc', folder: null, uuid: 'Compendium.sys.monsters.Actor.m1' },
      { id: 'm2', name: 'Zombie', type: null, folder: null, uuid: 'Compendium.sys.monsters.Actor.m2' },
    ]);
    assert.equal((await read('foundry_document', { uuid: 'Actor.g1' })).data.items[0].name, 'Scimitar');
    assert.deepEqual(await read('foundry_document', { uuid: 'Actor.g1', fields: ['name', 'system.attributes.hp', 'system.nothing.here', 'constructor', 'name.length'] }), {
      uuid: 'Actor.g1', documentName: 'Actor',
      fields: { name: 'Goblin Boss', 'system.attributes.hp': { value: 21, max: 21 }, 'system.nothing.here': null, constructor: null, 'name.length': null },
    });
    for (const [name, args, expected] of [
      ['foundry_documents', { type: 'Nonsense' }, /No world collection of "Nonsense". This world has: Actor, ChatMessage/],
      ['foundry_documents', { pack: 'no.such' }, /No compendium "no.such"/],
      ['foundry_document', { uuid: 'Actor.gone' }, /Nothing found at "Actor.gone"/],
      // Stored settings hold raw values, so they are not reachable as documents: that would sidestep foundry_settings.
      ['foundry_documents', { type: 'Setting' }, /Settings are read with foundry_settings/],
      ['foundry_document', { uuid: 'Setting.s1' }, /Settings are read with foundry_settings/],
    ]) {
      const result = await callTool(name, args);
      assert.equal(result.isError, true);
      assert.match(payload(result).error.message, expected);
    }
    // Arguments of the wrong shape never reach Foundry.
    assert.equal((await callTool('foundry_documents', { limit: 100000 })).isError, true);
    assert.equal((await callTool('foundry_document', {})).isError, true);
  });

  await check('arguments to the read-only tools are data, never code', async () => {
    const hostile = '"); globalThis.injected = true; ("\'`${globalThis.injected = true}`\n\u2028</script>\\';
    const missing = await callTool('foundry_document', { uuid: hostile, fields: [hostile, '__proto__.polluted'] });
    assert.equal(payload(missing).error.message, `Nothing found at "${hostile}".`);
    assert.equal(payload(await callTool('foundry_documents', { type: 'Actor', name: hostile })).result.total, 0);
    assert.match(payload(await callTool('foundry_documents', { pack: hostile })).error.message, /No compendium/);
    assert.equal(payload(await callTool('foundry_settings', { namespace: hostile, contains: hostile })).result.total, 0);
    // A key the tool does not define is dropped before the code is built.
    assert.equal(payload(await callTool('foundry_documents', { type: 'Actor', code: 'globalThis.injected = true' })).result.total, 2);
    assert.equal(globalThis.injected, undefined);
    assert.equal({}.polluted, undefined);
  });

  await check('settings are read, a text value under a credential-like key is withheld, and an unreadable setting does not cost the rest', async () => {
    settings['foundry-mcp.token'] = 'the-hub-token-itself';
    try {
      const all = payload(await callTool('foundry_settings')).result;
      assert.equal(all.total, 5);
      const byKey = Object.fromEntries(all.settings.map((setting) => [`${setting.namespace}.${setting.key}`, setting]));
      assert.match(byKey['foundry-mcp.token'].withheld, /credential/);
      assert.match(byKey['weather.apiKey'].withheld, /credential/);
      assert.ok(!JSON.stringify(all).includes('the-hub-token-itself') && !JSON.stringify(all).includes('sk-weather-123'));
      // "Token" is an everyday word in Foundry: a setting that is not text is shown.
      assert.deepEqual(byKey['core.defaultToken'], { namespace: 'core', key: 'defaultToken', scope: 'world', name: 'Default Token', value: { displayName: 20 } });
      assert.equal(byKey['weather.units'].value, 'metric');
      assert.match(byKey['weather.broken'].unreadable, /not a registered setting/);
      assert.equal(byKey['weather.broken'].name, null);
      assert.deepEqual(payload(await callTool('foundry_settings', { namespace: 'weather', contains: 'UNIT' })).result.settings.map((setting) => setting.key), ['units']);
      assert.deepEqual(payload(await callTool('foundry_settings', { contains: 'default token' })).result.settings.map((setting) => setting.key), ['defaultToken']);
      assert.equal(payload(await callTool('foundry_settings', { limit: 2 })).result.settings.length, 2);
    } finally {
      settings['foundry-mcp.token'] = '';
    }
  });

  await check('eval reads an actor, writes a flag and returns console output', async () => {
    const reply = await evalCode(`const a = game.actors.getName('Test Actor'); a.flags.mcp = { ok: true }; console.log('wrote flag'); return a;`);
    assert.deepEqual(reply.result, { name: 'Test Actor', flags: { mcp: { ok: true } } });
    assert.deepEqual(reply.logs, [{ level: 'log', text: 'wrote flag' }]);
    assert.equal(typeof reply.logSeq, 'number');
  });

  await check('eval reports thrown errors', async () => {
    const result = await callTool('foundry_eval', { code: `await null; throw new TypeError('boom');` });
    assert.equal(result.isError, true);
    assert.equal(payload(result).error.message, 'boom');
  });

  await check('a thrown value that cannot be read is reported and does not leak a slot', async () => {
    const hostile = `throw { get name() { throw new Error('no'); }, get message() { throw new Error('no'); } };`;
    // One at a time, and more of them than there are slots: if each leaked a slot, the later ones would be refused.
    for (let i = 0; i < 20; i++) {
      const reply = await callTool('foundry_eval', { code: hostile });
      assert.equal(reply.isError, true);
      assert.equal(payload(reply).error.name, '[Unreadable]', `call ${i + 1}`);
    }
    assert.equal((await evalCode('return 5')).result, 5);
  });

  await check('eval serializes awkward values', async () => {
    const reply = await evalCode(`const o = { big: 10n, when: new Date(0), set: new Set([1]) }; o.self = o; return o;`);
    assert.deepEqual(reply.result, { big: '10', when: '1970-01-01T00:00:00.000Z', set: [1], self: '[Circular]' });
    const odd = await evalCode(`return { bad: new Date('nope'), bytes: new Uint8Array(1000), map: new Map([['a', 1]]), get boom() { throw new Error('getter'); } };`);
    assert.deepEqual(odd.result, { bad: 'Invalid Date', bytes: '[Uint8Array 1000 bytes]', map: { a: 1 }, boom: '[Unreadable]' });
    const loops = await evalCode(`const m = new Map(); m.set('self', m); const s = new Set(); s.add(s); return { m, s, viaToObject: { toObject: () => 'plain' } };`);
    assert.deepEqual(loops.result, { m: { self: '[Circular]' }, s: ['[Circular]'], viaToObject: 'plain' });
    // A Foundry Collection is a Map that iterates its values, not its entries (found against a real world: `return game.actors`).
    const collection = await evalCode(`class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
      return new Collection([['a1', game.actors.get('a1')], ['n', 2]]);`);
    assert.deepEqual(collection.result, { a1: { name: 'Test Actor', flags: { mcp: { ok: true } } }, n: 2 });
    // A key named "__proto__" (a flags object can have one) is data like any other key.
    const proto = await callTool('foundry_eval', { code: `return { map: new Map([['__proto__', { a: 1 }], ['z', 2]]), plain: JSON.parse('{"__proto__": 5, "y": 1}') };` });
    assert.equal(JSON.stringify(JSON.parse(proto.content[0].text).result), '{"map":{"__proto__":{"a":1},"z":2},"plain":{"__proto__":5,"y":1}}');
  });

  await check('a timeout returns promptly and aborts the signal given to the code', async () => {
    const result = await callTool('foundry_eval', {
      code: `await new Promise((resolve) => signal.addEventListener('abort', resolve)); globalThis.sawAbort = true;`,
      timeoutMs: 1000,
    });
    assert.match(result.content[0].text, /Timed out/);
    await sleep(200);
    assert.equal((await evalCode('return globalThis.sawAbort === true')).result, true);
  });

  await check('concurrent evaluations are answered separately and capped', async () => {
    // Each call waits at a gate, so all sixteen are provably still running when the seventeenth arrives.
    globalThis.gate = [];
    const calls = Array.from({ length: 17 }, (_, i) => callTool('foundry_eval', { code: `await new Promise((r) => globalThis.gate.push(r)); return ${i};` }));
    await Promise.race(calls); // the refusal is the only one that can finish
    assert.equal(globalThis.gate.length, 16);
    globalThis.gate.forEach((open) => open());
    const replies = await Promise.all(calls);
    const refused = replies.filter((r) => r.isError);
    assert.equal(refused.length, 1);
    assert.match(refused[0].content[0].text, /already running/);
    assert.deepEqual(replies.filter((r) => !r.isError).map((r) => payload(r).result), Array.from({ length: 16 }, (_, i) => i));
  });

  await check('a console line is turned into text once, however many evaluations are listening', async () => {
    // Counted, not timed: three evaluations wait at a gate while something logs an object.
    globalThis.gate = [];
    const calls = Array.from({ length: 3 }, () => evalCode(`await new Promise((r) => globalThis.gate.push(r)); return 1;`));
    await until(() => globalThis.gate.length === 3, 'three evaluations to be running');
    let serialized = 0;
    console.warn('watched', { toObject() { serialized += 1; return { hp: 7 }; } });
    assert.equal(serialized, 1, 'serialized once for three captures and the log buffer');
    // A huge object costs a bounded amount of work, because a line keeps only 8000 characters of it.
    let reads = 0;
    const big = {};
    for (let i = 0; i < 20_000; i++) Object.defineProperty(big, `k${i}`, { enumerable: true, get: () => ((reads += 1), i) });
    console.warn(big);
    assert.ok(reads <= 5000, `read ${reads} of 20000 properties`);
    // console.log is kept by nobody once no evaluation is listening, so it is not serialized at all.
    globalThis.gate.forEach((open) => open());
    const replies = await Promise.all(calls);
    for (const reply of replies) {
      assert.equal(reply.logs[0].text, 'watched {"hp":7}');
      assert.equal(reply.logs[1].text.length, 8000);
    }
    serialized = 0;
    console.log('unwatched', { toObject() { serialized += 1; return {}; } });
    assert.equal(serialized, 0);
  });

  // ------------------------------------------------- document changes and dice
  await check('eval lists the document changes it caused; later ones, secrets withheld, come from foundry_changes', async () => {
    const before = await evalCode('return 1;');
    assert.equal(before.changes, undefined, 'no tracking without Foundry hooks');
    assert.equal(before.changesSeq, undefined);
    // The hook and document API the tracker uses, as Foundry 14 provides it.
    const handlers = {};
    Hooks.on = (name, fn) => (handlers[name] ??= []).push(fn);
    Hooks.fire = (name, ...args) => (handlers[name] ?? []).forEach((fn) => fn(...args));
    globalThis.CONST = { ALL_DOCUMENT_TYPES: ['Actor', 'Item', 'User', 'Setting'] };
    globalThis.foundry = { utils: { getProperty: (object, path) => path.split('.').reduce((value, key) => value?.[key], object) } };
    game.user.id = 'gm1';
    game.users = new Map([['gm1', { name: 'Gamemaster' }], ['p1', { name: 'Player' }]]);
    globalThis.testHero = { documentName: 'Actor', uuid: 'Actor.h1', name: 'Hero', parent: null, type: 'character', _source: { system: { hp: 10 } } };
    // In Foundry the hooks exist before the first call; here they arrived late, so start tracking explicitly.
    assert.equal(payload(await callTool('foundry_changes')).matched, 0);

    const reply = await evalCode(`
      const hero = globalThis.testHero;
      Hooks.fire('preUpdateActor', hero, { system: { hp: 4 } });
      hero._source.system.hp = 4;
      Hooks.fire('updateActor', hero, { _id: 'h1', system: { hp: 4 }, _stats: { modifiedTime: 1 } }, {}, 'gm1');
      Hooks.fire('updateActor', hero, { _id: 'h1', _stats: { modifiedTime: 2 } }, {}, 'gm1'); // nothing changed: not recorded
      Hooks.fire('createItem', { documentName: 'Item', uuid: 'Actor.h1.Item.i1', name: 'Sword', type: 'weapon', parent: hero }, {}, 'gm1');
      return 'done';`);
    assert.equal(reply.result, 'done');
    assert.deepEqual(reply.changes.map((change) => [change.action, change.uuid]), [['update', 'Actor.h1'], ['create', 'Actor.h1.Item.i1']]);
    assert.deepEqual(reply.changes[0].changes, [{ path: 'system.hp', value: 4, before: 10 }]);
    assert.equal(reply.changes[0].user, 'Gamemaster');
    assert.equal(reply.changes[0].self, true);
    assert.equal(reply.changes[1].parent, 'Actor.h1');
    assert.equal(typeof reply.changesSeq, 'number');

    // After the call returned: a player's changes, with Foundry's deletion operator, a deleted document and secrets.
    const deletion = { toJSON: () => ({ __$OPERATOR$__: 'ForcedDeletion' }) };
    Hooks.fire('updateUser', { documentName: 'User', uuid: 'User.p1', name: 'Player' }, { password: 'hunter2hunter2', flags: { mod: { old: deletion }, x: { '-=gone': null } } }, {}, 'p1');
    Hooks.fire('updateSetting', { documentName: 'Setting', uuid: 'Setting.s9', key: 'weather.apiKey' }, { value: '"sk-live-1"' }, {}, 'gm1');
    Hooks.fire('deleteActor', { documentName: 'Actor', uuid: 'Actor.h2', name: 'Old', type: 'npc', toObject: () => ({ name: 'Old', flags: { mod: { apiKey: 'abc123secret', note: 'kept' } } }) }, {}, 'p1');

    const later = payload(await callTool('foundry_changes', { since: reply.changesSeq }));
    assert.equal(later.matched, 5);
    const [, , user, setting, removed] = later.entries;
    assert.equal(user.self, false);
    assert.equal(user.user, 'Player');
    assert.deepEqual(user.changes, [{ path: 'password', value: '[withheld]' }, { path: 'flags.mod.old', deleted: true }, { path: 'flags.x.gone', deleted: true }]);
    assert.deepEqual(setting.changes, [{ path: 'value', value: '[withheld]' }]);
    assert.deepEqual(removed.data, { name: 'Old', flags: { mod: { apiKey: '[withheld]', note: 'kept' } } });
    assert.ok(!JSON.stringify(later).includes('hunter2') && !JSON.stringify(later).includes('sk-live') && !JSON.stringify(later).includes('abc123secret'));

    const scoped = payload(await callTool('foundry_changes', { since: reply.changesSeq, uuid: 'Actor.h1' }));
    assert.deepEqual(scoped.entries.map((entry) => entry.uuid), ['Actor.h1', 'Actor.h1.Item.i1'], 'a uuid includes the documents embedded in it');
    assert.equal(payload(await callTool('foundry_changes', { documentName: 'Setting' })).matched, 1);

    // Credentials inside arrays and objects, in new values and in the earlier values of a deleted subtree.
    const vault = { documentName: 'Actor', uuid: 'Actor.v1', name: 'Vault', parent: null, _source: { flags: { mod: { creds: { apiKey: 'zz-old-key-zz', note: 'kept' } } } } };
    const cursor = payload(await callTool('foundry_changes')).lastSeq;
    Hooks.fire('preUpdateActor', vault, { flags: { mod: { '-=creds': null } } });
    Hooks.fire('updateActor', vault, { flags: { mod: { '-=creds': null } } }, {}, 'gm1');
    Hooks.fire('updateActor', vault, { flags: { mod: { list: [{ password: 'zz-in-array-zz' }], apiKeys: ['zz-key-list-zz'] } } }, {}, 'gm1');
    const nested = payload(await callTool('foundry_changes', { since: cursor }));
    assert.ok(!JSON.stringify(nested).includes('zz-'), 'no credential is reported at any depth');
    assert.deepEqual(nested.entries[0].changes, [{ path: 'flags.mod.creds', deleted: true, before: { apiKey: '[withheld]', note: 'kept' } }]);
    assert.deepEqual(nested.entries[1].changes, [{ path: 'flags.mod.list', value: [{ password: '[withheld]' }] }, { path: 'flags.mod.apiKeys', value: ['[withheld]'] }]);

    // Updates to one document that overlap cannot be matched to their earlier values, so those are left out.
    const overlap = payload(await callTool('foundry_changes')).lastSeq;
    const pair = { documentName: 'Actor', uuid: 'Actor.p2', name: 'Pair', parent: null, _source: { system: { hp: 1 } } };
    Hooks.fire('preUpdateActor', pair, { system: { hp: 2 } });
    Hooks.fire('preUpdateActor', pair, { system: { hp: 3 } });
    Hooks.fire('updateActor', pair, { system: { hp: 2 } }, {}, 'gm1');
    Hooks.fire('updateActor', pair, { system: { hp: 3 } }, {}, 'gm1');
    Hooks.fire('preUpdateActor', pair, { system: { hp: 5 } });
    Hooks.fire('updateActor', pair, { system: { hp: 4 } }, {}, 'p1'); // another user's update lands first
    Hooks.fire('updateActor', pair, { system: { hp: 5 } }, {}, 'gm1');
    Hooks.fire('preUpdateActor', pair, { system: { hp: 6 } });
    Hooks.fire('updateActor', pair, { system: { hp: 6 } }, {}, 'gm1');
    const rows = payload(await callTool('foundry_changes', { since: overlap })).entries.map((entry) => entry.changes[0]);
    assert.deepEqual(rows, [{ path: 'system.hp', value: 2 }, { path: 'system.hp', value: 3 }, { path: 'system.hp', value: 4 }, { path: 'system.hp', value: 5 }, { path: 'system.hp', value: 6, before: 1 }]);
    assert.equal(handlers.updateActor.length, 1, 'the hooks are installed once');
  });

  await check('evaluations that overlap never list the same change twice', async () => {
    await evalCode('return 0;'); // takes up the previous check's changes
    const slow = evalCode(`
      await new Promise((resolve) => (globalThis.releaseSlow = resolve));
      return 'slow';`);
    while (!globalThis.releaseSlow) await new Promise((resolve) => setTimeout(resolve, 10));
    const fast = await evalCode(`Hooks.fire('updateActor', globalThis.testHero, { system: { hp: 7 } }, {}, 'gm1'); return 'fast';`);
    globalThis.releaseSlow();
    const late = await slow;
    assert.deepEqual(fast.changes?.map((change) => change.changes[0].value), [7]);
    assert.equal(late.changes, undefined, 'the call that finished later does not list it again');
  });

  await check('a tab clock that runs behind still credits a change to its call, and no change is credited twice', async () => {
    const fire = `
      const hero = globalThis.testHero;
      const realNow = Date.now;
      Date.now = () => realNow() - 200; // a coarse or lagging browser clock
      try { Hooks.fire('updateActor', hero, { system: { hp: ARG } }, {}, 'gm1'); } finally { Date.now = realNow; }
      return 'fired';`;
    await evalCode('return 0;'); // takes up the previous check's changes, made within the slack just before
    const first = await evalCode(fire.replace('ARG', '3'));
    assert.deepEqual(first.changes?.map((change) => change.changes[0].value), [3]);
    const second = await evalCode(fire.replace('ARG', '2'));
    assert.deepEqual(second.changes?.map((change) => change.changes[0].value), [2], 'the first call\'s change is not repeated');
    assert.equal((await evalCode('return 0;')).changes, undefined, 'a call that changes nothing lists nothing');
  });

  await check('dice can be seeded and forced, and Foundry\'s own rolling comes back afterwards', async () => {
    // Foundry 14's DiceTerm face mapping, and a stand-in for its Mersenne Twister.
    class DiceTerm {
      constructor(faces) {
        this.faces = faces;
        this.minValue = 1;
      }
      mapRandomFace(randomUniform) {
        return this.minValue - 1 + Math.ceil((1 - randomUniform) * this.faces);
      }
      randomFace() {
        return this.mapRandomFace(CONFIG.Dice.randomUniform());
      }
    }
    class MersenneTwister {
      constructor(seed) {
        this.state = seed % 2147483647 || 1;
      }
      random() {
        this.state = (this.state * 48271) % 2147483647;
        return (this.state - 1) / 2147483646;
      }
    }
    const ownRandom = () => Math.random();
    const ownHandler = (term) => term.mapRandomFace(Math.random());
    const ownMap = DiceTerm.prototype.mapRandomFace;
    globalThis.CONFIG = { Dice: { randomUniform: ownRandom, fulfillment: { methods: { mersenne: { handler: ownHandler } } } } };
    foundry.dice = { terms: { DiceTerm }, MersenneTwister };
    const d20s = () => Array.from({ length: 8 }, () => new DiceTerm(20).randomFace());
    const dice = async (args) => payload(await callTool('foundry_dice', args)).result;

    assert.deepEqual(await dice({}), { seed: null, queued: [], forced: 0, active: false });
    assert.equal((await dice({ seed: 42 })).seed, 42);
    const first = d20s();
    await dice({ seed: 42 });
    assert.deepEqual(d20s(), first, 'the same seed gives the same rolls');
    await dice({ seed: 42 });
    assert.deepEqual(Array.from({ length: 8 }, () => CONFIG.Dice.fulfillment.methods.mersenne.handler(new DiceTerm(20))), first, 'the Mersenne fulfillment method is seeded too');

    const queued = await dice({ next: [{ faces: 20, result: 20 }, { result: 3 }, { result: 9 }] });
    assert.equal(queued.queued.length, 3);
    assert.equal(new DiceTerm(6).randomFace(), 3, 'an entry without faces is used by the first die it fits');
    assert.ok(new DiceTerm(4).randomFace() <= 4, 'a d20 entry and a 9 do not fit a d4');
    assert.equal(new DiceTerm(20).randomFace(), 20);
    const state = await dice({});
    assert.equal(state.forced, 2);
    assert.deepEqual(state.queued, [{ result: 9 }]);
    assert.deepEqual((await dice({ clear: true })).queued, []);

    assert.deepEqual(await dice({ seed: null }), { seed: null, queued: [], forced: 2, active: false });
    assert.equal(CONFIG.Dice.randomUniform, ownRandom);
    assert.equal(CONFIG.Dice.fulfillment.methods.mersenne.handler, ownHandler);
    assert.equal(DiceTerm.prototype.mapRandomFace, ownMap);

    // Another module wraps the random source and the Mersenne handler while dice control is on. Its wrappers stay,
    // through a reseed too, and once control is off they roll with Foundry's own random source again.
    const mersenne = CONFIG.Dice.fulfillment.methods.mersenne;
    await dice({ seed: 7 });
    const ours = CONFIG.Dice.randomUniform;
    const wrapped = function (...rest) { return ours.apply(this, rest); };
    const ourHandler = mersenne.handler;
    const wrappedHandler = (term) => ourHandler(term);
    CONFIG.Dice.randomUniform = wrapped;
    mersenne.handler = wrappedHandler;
    await dice({ seed: 8 });
    assert.equal(CONFIG.Dice.randomUniform, wrapped, 'reseeding leaves the other module\'s wrapper in place');
    assert.equal(mersenne.handler, wrappedHandler);
    assert.equal((await dice({ seed: null })).active, false);
    let ownRolls = 0;
    const realRandom = Math.random;
    Math.random = () => (ownRolls++, 0.5);
    try {
      CONFIG.Dice.randomUniform();
      mersenne.handler(new DiceTerm(20));
    } finally {
      Math.random = realRandom;
    }
    assert.equal(ownRolls, 2, 'the wrapped functions pass rolls to Foundry\'s own once control is off');
    CONFIG.Dice.randomUniform = ownRandom;
    mersenne.handler = ownHandler;

    // Asking for the state changes nothing, even once the queue has been used up.
    await dice({ next: [{ result: 4 }] });
    assert.equal(new DiceTerm(6).randomFace(), 4);
    assert.deepEqual(await dice({}), { seed: null, queued: [], forced: 1, active: false });
    assert.equal((await dice({})).forced, 1, 'a report does not reset the count');
    await dice({ clear: true });
    assert.equal(DiceTerm.prototype.mapRandomFace, ownMap);
    const refused = await mcp('tools/call', { name: 'foundry_dice', arguments: { seed: -1 } });
    assert.ok(refused.error || refused.result?.isError, 'a negative seed is refused');
    assert.equal(CONFIG.Dice.randomUniform, ownRandom);
  });

  // -------------------------------------------------------------------- logs
  await check('an error logged after eval returned is found with since=logSeq and marked fromEval', async () => {
    const reply = await evalCode(`setTimeout(() => console.error('late', new Error('late failure')), 100); return 'returned';`);
    assert.equal(reply.result, 'returned');
    assert.deepEqual(reply.logs, []);
    await sleep(400);
    const logs = await getLogs({ since: reply.logSeq });
    assert.equal(logs.entries.length, 1);
    const [entry] = logs.entries;
    assert.equal(entry.text, 'late Error: late failure');
    assert.equal(entry.level, 'error');
    assert.equal(entry.fromEval, true);
    assert.deepEqual(entry.packages, []);
    assert.ok(entry.stack.every((frame) => frame.startsWith('at ')));
    assert.ok(entry.stack.some((frame) => frame.includes('foundry-mcp-eval.js')));
  });

  await check("another module's asynchronous failure is attributed to that module", async () => {
    const reply = await evalCode(`fakeAutomation.failLater(100); return 1;`);
    await sleep(400);
    const logs = await getLogs({ since: reply.logSeq, package: 'fake-automation' });
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0].fromEval, false);
    assert.deepEqual(logs.entries[0].packages, ['fake-automation']);
    assert.match(logs.entries[0].text, /workflow failed Error: target is not defined/);
    assert.equal((await getLogs({ since: reply.logSeq, package: 'other-module' })).entries.length, 0);
  });

  await check('uncaught exceptions and unhandled rejections are captured', async () => {
    const before = (await getLogs()).lastSeq;
    window.dispatchEvent(Object.assign(new Event('error'), { message: 'Uncaught ReferenceError: nope', error: new ReferenceError('nope') }));
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('promise went wrong') }));
    await sleep(200);
    const logs = await getLogs({ since: before });
    assert.deepEqual(logs.entries.map((e) => [e.source, e.text]), [
      ['uncaught', 'Uncaught ReferenceError: nope'],
      ['rejection', 'promise went wrong'],
    ]);
  });

  await check('credentials are redacted before leaving the browser, in logs and in eval output', async () => {
    const before = (await getLogs()).lastSeq;
    const secrets = [
      'login failed password=hunter22 api_key: "abc123" cobalt-token=zzz999 token=plain123 Token Goblin is fine',
      'https://example.test/hook?user=bob&token=qwerty123&x=1',
      'Authorization: Bearer abcdefgh12345678',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'Cookie: session=abc123; refresh=anotherSecret456',
      '{"token":"abcdefghijklmnopqrstuvwxyzABCDEF","name":"kept","apiKey":"k-123"}',
      'sent with Bearer abcdefgh12345678 ok',
      'client_secret=hunter22 openai_api_key=sk-short123 hub_token=abc12345',
      'https://gm:secretpass@foundry.example/api',
      '{"headers":{"Authorization":"Bearer tok12345678"},"status":502,"reason":"Bad Gateway"}',
      'password="two word secret" then more',
      `{"password":"abc'restOfSecret","note":"an \\"escaped\\" value"}`,
      '{"tokenName":"Goblin","tokenId":"abc123"} Secret: a hidden door',
      'time: password=afterAnotherKey',
    ].join('\n');
    const expected = [
      'login failed password=[redacted] api_key: "[redacted]" cobalt-token=[redacted] token=[redacted] Token Goblin is fine',
      'https://example.test/hook?user=bob&token=[redacted]&x=1',
      'Authorization: [redacted]',
      'Authorization: [redacted]',
      'Cookie: [redacted]',
      '{"token":"[redacted]","name":"kept","apiKey":"[redacted]"}',
      'sent with Bearer [redacted] ok',
      'client_secret=[redacted] openai_api_key=[redacted] hub_token=[redacted]',
      'https://gm:[redacted]@foundry.example/api',
      '{"headers":{"Authorization":"[redacted]"},"status":502,"reason":"Bad Gateway"}',
      'password="[redacted]" then more',
      `{"password":"[redacted]","note":"an \\"escaped\\" value"}`,
      '{"tokenName":"Goblin","tokenId":"abc123"} Secret: a hidden door',
      'time: password=[redacted]',
    ].join('\n');
    console.error(secrets);
    console.warn('blob ' + 'A1b2'.repeat(12));
    console.warn('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl');
    console.warn('padded ' + 'Q1w2'.repeat(10) + 'ab== ' + '-'.repeat(60) + ' aVeryLongFunctionNameWithoutAnyDigitsInItAtAllReally');
    await sleep(200);
    assert.deepEqual((await getLogs({ since: before })).entries.map((e) => e.text), [
      expected,
      'blob [redacted]',
      'jwt [redacted]',
      'padded [redacted] ' + '-'.repeat(60) + ' aVeryLongFunctionNameWithoutAnyDigitsInItAtAllReally',
    ]);
    const reply = await evalCode(`console.log(${JSON.stringify(secrets)}); return 1;`);
    assert.deepEqual(reply.logs, [{ level: 'log', text: expected }]);
  });

  await check('everyday credential shapes are redacted: plain "token:", empty user names, "@" in passwords, known key prefixes', async () => {
    const before = (await getLogs()).lastSeq;
    const cases = [
      ['token: abc123 secret: s3cr3tvalue', 'token: [redacted] secret: [redacted]'],
      ['token: "abc123" Secret: longenoughtobeakey', 'token: "[redacted]" Secret: [redacted]'],
      // Everyday tabletop text is left alone.
      ['Token: Goblin Secret: a hidden door token: "Goblin" Token: 5', 'Token: Goblin Secret: a hidden door token: "Goblin" Token: 5'],
      ['redis://:sup3rSecret@cache.local:6379/0', 'redis://:[redacted]@cache.local:6379/0'],
      ['mongodb://admin:p@ssw0rdMore@db.local/x', 'mongodb://admin:[redacted]@db.local/x'],
      ['amqp://user:pa@ss@mq.local?x=1 next', 'amqp://user:[redacted]@mq.local?x=1 next'],
      ['http://localhost:30000/modules/x.js mail gm@example.com', 'http://localhost:30000/modules/x.js mail gm@example.com'],
      ['{"url":"http://host:8080","email":"gm@example.com"}', '{"url":"http://host:8080","email":"gm@example.com"}'],
      ['aws AKIAIOSFODNN7EXAMPLE stripe sk_live_abc123DEF456 github ghp_abcdefghij0123456789ABCD', 'aws [redacted] stripe [redacted] github [redacted]'],
    ];
    console.error(cases.map(([input]) => input).join('\n'));
    const [entry] = (await until(async () => { const logs = await getLogs({ since: before }); return logs.entries.length && logs; }, 'the log entry')).entries;
    assert.deepEqual(entry.text.split('\n'), cases.map(([, output]) => output));
  });

  await check('level, text and limit filters work; console.log is not retained', async () => {
    const before = (await getLogs()).lastSeq;
    console.log('just chatter');
    fixture.warnNow('first warning');
    console.error('an error');
    fixture.warnNow('second warning');
    await sleep(200);
    assert.deepEqual((await getLogs({ since: before })).entries.map((e) => e.text), ['first warning', 'an error', 'second warning']);
    assert.deepEqual((await getLogs({ since: before, level: 'error' })).entries.map((e) => e.text), ['an error']);
    assert.deepEqual((await getLogs({ since: before, contains: 'WARNING' })).entries.map((e) => e.text), ['first warning', 'second warning']);
    const limited = await getLogs({ since: before, limit: 1 });
    assert.equal(limited.matched, 3);
    assert.deepEqual(limited.entries.map((e) => e.text), ['second warning']);
  });

  await check('a repeating error collapses into one entry with a count, but not across different sources', async () => {
    const before = (await getLogs()).lastSeq;
    const again = () => console.warn('same thing again');
    for (let i = 0; i < 5; i++) again();
    await evalCode(`console.warn('same thing again');`); // same text, but from evaluated code
    await sleep(200);
    const logs = await getLogs({ since: before });
    assert.deepEqual(logs.entries.map((e) => [e.count, e.fromEval]), [[5, false], [1, true]]);
    // Same text and same kind of source, but logged from two different places.
    const start = (await getLogs()).lastSeq;
    const fromHere = () => console.warn('one message, two origins');
    const fromThere = () => console.warn('one message, two origins');
    fromHere();
    fromThere();
    await sleep(200);
    assert.deepEqual((await getLogs({ since: start })).entries.map((e) => e.count), [1, 1]);
  });

  await check('huge results and chatty code are cut down in the browser', async () => {
    const reply = await evalCode(`
      for (let i = 0; i < 500; i++) console.log('line ' + i);
      return 'done';`);
    assert.equal(reply.result, 'done');
    assert.equal(reply.logs.length, 200);
    assert.equal(reply.logsDropped, 300);
    // The hub caps the reply at 80,000 characters and says how much it cut off,
    // which reveals how much the browser sent. Unbounded, each of these is about a million characters.
    const sentChars = async (code) => {
      const text = (await callTool('foundry_eval', { code })).content[0].text;
      assert.ok(text.length <= 80_000, 'the reply is within the limit');
      const cut = JSON.parse(text); // a cut reply is still JSON, and keeps the fields a caller needs
      assert.equal(typeof cut.logSeq, 'number');
      assert.deepEqual(cut.logs, []);
      assert.match(JSON.stringify(cut.result), /\[Truncated/);
      return cut.truncated.chars;
    };
    assert.ok((await sentChars(`return 'x'.repeat(1_000_000);`)) < 450_000, 'long strings are cut');
    assert.ok((await sentChars(`return Array.from({ length: 100_001 }, (_, i) => 100_000 + i);`)) < 600_000, 'long lists are cut');
    assert.ok((await sentChars(`return new Set(Array.from({ length: 100_001 }, (_, i) => 100_000 + i));`)) < 600_000, 'long sets are cut');
    assert.ok((await sentChars(`return { ['k'.repeat(1_000_000)]: 1 };`)) < 450_000, 'long keys are cut');
    assert.ok((await sentChars(`return { toObject: () => 'x'.repeat(1_000_000) };`)) < 450_000, 'text from toObject() is cut');
    // Text that doubles in size when written as JSON still ends up within the limit.
    assert.ok((await sentChars(`return '"'.repeat(300_000);`)) > 80_000);
  });

  await check('a log reply that is too long drops its oldest entries and stays valid JSON', async () => {
    const before = (await getLogs()).lastSeq;
    for (let i = 0; i < 50; i++) console.warn(`entry ${i} ${'lorem ipsum '.repeat(160)}`);
    await until(async () => (await getLogs({ since: before, limit: 1 })).matched === 50, 'fifty entries to arrive');
    const result = await callTool('foundry_logs', { since: before, limit: 200 });
    assert.ok(result.content[0].text.length <= 80_000);
    const logs = payload(result);
    assert.equal(logs.matched, 50);
    assert.ok(logs.entriesOmitted > 0);
    assert.equal(logs.entries.length + logs.entriesOmitted, 50);
    assert.match(logs.entries.at(-1).text, /^entry 49 /, 'the newest entries are the ones kept');
  });

  await check('a flood is rate-limited in the browser and the buffer stays bounded', async () => {
    await sleep(1100); // start a fresh one-second window
    for (let i = 0; i < 300; i++) console.error(`flood ${i}`);
    await sleep(1100);
    console.error('after the flood');
    await sleep(200);
    const logs = await getLogs({ limit: 200 });
    assert.ok(logs.entries.length <= 60, 'hub keeps at most logLimit entries');
    assert.ok(logs.evicted > 0);
    assert.ok(logs.entries.filter((e) => e.text.startsWith('flood')).length <= 100);
    assert.ok(logs.entries.at(-1).droppedBefore >= 200, 'the next entry says how many were dropped');
  });

  // ------------------------------------------------------- access and origins
  await check('a second GM tab is turned away while the first is connected', async () => {
    assert.deepEqual(await rawSocket(PORT, ORIGIN), { outcome: 'closed', code: 4001 });
  });

  await check('a web page cannot call the MCP endpoint, and only POST is served', async () => {
    assert.equal((await mcp('tools/list', {}, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await mcp('tools/list', {}, { headers: { origin: 'null' } })).status, 403);
    assert.equal((await mcp('tools/list', {}, { httpMethod: 'GET' })).status, 405);
    // DNS rebinding: the request reaches loopback but names another host. fetch cannot fake Host, so go lower.
    const rebound = await new Promise((resolve) =>
      request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { host: 'attacker.example' } }, (res) => resolve(res.statusCode)).end('{}')
    );
    assert.equal(rebound, 403);
    // Without the token a caller learns nothing about the endpoint, not even which methods it serves.
    assert.equal((await mcp('tools/list', {}, { httpMethod: 'GET', port: TOKEN_PORT })).status, 401);
    const tooBig = await new Promise((resolve) =>
      request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { 'content-length': 5_000_000 } }, (res) => resolve(res.statusCode))
        .on('error', () => resolve('reset'))
        .end('{}')
    );
    assert.equal(tooBig, 413);
  });

  await check('a page from another origin cannot pose as Foundry', async () => {
    assert.equal((await rawSocket(PORT, 'https://evil.example')).outcome, 'rejected');
  });

  await check('malformed socket messages close that socket and leave the hub running', async () => {
    // Broken input closes the socket with 4002; input that is merely not a hello is ignored until the handshake deadline.
    for (const [firstMessage, expected] of [
      ['not json', 4002],
      ['{"hello":{"world":{"toString":null}}}', 4002],
      ['{"hello":{"world":"w"}}', 4002],
      ['{"hello":null}', 'ignored'],
      ['[]', 'ignored'],
    ]) {
      const result = await Promise.race([rawSocket(PORT, ORIGIN, undefined, { firstMessage }), sleep(1500).then(() => ({ outcome: 'ignored' }))]);
      assert.equal(result.code ?? result.outcome, expected, firstMessage);
    }
    assert.equal((await evalCode('return 7')).result, 7);
  });

  await check('a log line with an impossible time is kept and does not cost the connection', async () => {
    // This hub was given its origin as "http://LOCALHOST:30000/"; being welcomed shows it was normalised.
    const tab = await rawSocket(BARE_PORT, ORIGIN);
    assert.equal(tab.outcome, 'welcomed');
    const times = [1e20, 8.64e15 + 1, -1e20, 'soon', null, 1e12];
    times.forEach((time, i) => tab.ws.send(JSON.stringify({ log: { time, level: 'warn', text: `odd time ${i}` } })));
    const logs = await until(async () => {
      const found = payload(await callTool('foundry_logs', { contains: 'odd time' }, { port: BARE_PORT }));
      return found.entries.length === times.length && found;
    }, 'all six log lines');
    assert.equal(logs.connected, true);
    assert.ok(logs.entries.every((entry) => !Number.isNaN(Date.parse(entry.time))));
    assert.equal(logs.entries.at(-1).time, '2001-09-09T01:46:40.000Z', 'a sensible time is still used as given');
    tab.ws.close();
    await until(async () => !payload(await callTool('foundry_logs', { limit: 1 }, { port: BARE_PORT })).connected, 'the hub to notice the close');
  });

  await check('a socket that fails to send costs one call, not the hub', async () => {
    // A stand-in tab that never answers, on a hub whose sockets fail on demand.
    const tab = await rawSocket(FAULT_PORT, ORIGIN);
    assert.equal(tab.outcome, 'welcomed');
    const options = { port: FAULT_PORT };
    const unsent = await callTool('foundry_eval', { code: '/* FAULT_SEND */ return 1' }, options);
    assert.equal(unsent.isError, true);
    assert.match(unsent.content[0].text, /could not be sent to Foundry/);
    // The cancel that follows a timeout is sent from a timer, where a throw would end the process.
    const timedOut = await callTool('foundry_eval', { code: '/* FAULT_CANCEL */ return 1', timeoutMs: 1000 }, options);
    assert.match(timedOut.content[0].text, /Timed out/);
    // Still running, and neither call kept a slot: sixteen more are accepted and the seventeenth is refused.
    const more = Array.from({ length: 17 }, () => callTool('foundry_eval', { code: 'return 1', timeoutMs: 1000 }, options));
    const replies = await Promise.all(more);
    assert.equal(replies.filter((r) => /already running/.test(r.content[0].text)).length, 1);
    assert.equal(replies.filter((r) => /Timed out/.test(r.content[0].text)).length, 16);
    tab.ws.close();
  });

  await check('clients that open with an MCP initialize handshake are served', async () => {
    const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'foundry');
    assert.match(init.result.instructions, /foundry_status first/);
  });

  await check('the official MCP client connects, lists the tools and calls one', async () => {
    const client = new Client({ name: 'foundry-mcp-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['foundry_status', 'foundry_documents', 'foundry_document', 'foundry_settings', 'foundry_eval', 'foundry_dice', 'foundry_changes', 'foundry_logs']);
    const reply = await client.callTool({ name: 'foundry_eval', arguments: { code: 'return 6 * 7' } });
    assert.equal(JSON.parse(reply.content[0].text).result, 42);
    await client.close();
  });

  await check('a client that disconnects stops holding a slot and the code is told to stop', async () => {
    const gone = new AbortController();
    const call = fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      signal: gone.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'foundry_eval', arguments: { code: `await new Promise((r) => signal.addEventListener('abort', r)); globalThis.clientGone = true;`, timeoutMs: 60_000 } } }),
    }).catch(() => 'aborted');
    await sleep(400);
    gone.abort();
    assert.equal(await call, 'aborted');
    await sleep(400);
    assert.equal((await evalCode('return globalThis.clientGone === true')).result, true);
  });

  await check('a call in flight when Foundry disconnects fails at once instead of timing out', async () => {
    const call = callTool('foundry_eval', { code: 'await new Promise(() => {});', timeoutMs: 60_000 });
    await sleep(300);
    moduleSockets.at(-1).close();
    assert.match((await call).content[0].text, /disconnected before replying/);
    await sleep(6000); // reconnects
    assert.equal((await evalCode('return 3')).result, 3);
  });

  await check('logs survive a Foundry disconnect, stay readable, and are bounded by markers', async () => {
    await callTool('foundry_logs', { clear: true });
    console.warn('before the reload');
    await sleep(200);
    moduleSockets.at(-1).close(); // the module reconnects 5 s after a close
    await sleep(500);
    let logs = await getLogs();
    assert.equal(logs.connected, false);
    assert.deepEqual(logs.entries.map((e) => e.text.slice(0, 20)), ['before the reload', 'Foundry disconnected']);
    console.error('raised while disconnected');
    await sleep(6000);
    logs = await getLogs();
    assert.equal(logs.connected, true);
    assert.deepEqual(logs.entries.map((e) => [e.source, e.text.slice(0, 25)]), [
      ['console', 'before the reload'],
      ['bridge', 'Foundry disconnected (wor'],
      ['bridge', 'Foundry connected (new pa'],
      ['console', 'raised while disconnected'],
    ]);
    assert.equal((await evalCode('return 2')).result, 2);
  });

  await check('clear empties the buffer for everyone', async () => {
    assert.ok((await getLogs({ clear: true })).entries.length > 0);
    assert.equal((await getLogs()).entries.length, 0);
  });

  await check('a world that is not on the allowlist gets no code and keeps no logs', async () => {
    game.world.id = 'live-campaign';
    moduleSockets.at(-1).close();
    await sleep(6000); // module reconnects and says hello with the new world id
    const result = await callTool('foundry_eval', { code: 'return 1' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not on this hub's allowlist/);
    console.error('private thing from the live campaign');
    await sleep(200);
    assert.equal((await getLogs({ contains: 'private thing' })).entries.length, 0);
    assert.equal((await getLogs()).world, null, 'its id is not reported to clients');
    // It did not take the one connection slot: the test world's tab can still connect.
    const testWorldTab = await rawSocket(PORT, ORIGIN);
    assert.equal(testWorldTab.outcome, 'welcomed');
    testWorldTab.ws.close();
    game.world.id = 'test-world';
  });

  // ------------------------------------------------------------------- token
  await check('a hub with a token refuses MCP calls without it', async () => {
    assert.equal((await mcp('tools/list', {}, { port: TOKEN_PORT })).status, 401);
    assert.equal((await mcp('tools/list', {}, bearer('wrong'))).status, 401);
    assert.equal((await toolNames(bearer(TOKEN))).length, 8);
  });

  await check('a module without the right token cannot connect to a token hub', async () => {
    assert.deepEqual(await rawSocket(TOKEN_PORT, ORIGIN, 'wrong'), { outcome: 'closed', code: 4003 });
    const before = moduleSockets.length;
    await startModule(`ws://127.0.0.1:${TOKEN_PORT}/foundry`, ''); // real module, no token configured
    assert.equal(moduleSockets.length, before + 1);
    assert.equal(moduleSockets.at(-1).closeCode, 4003, 'the module itself gave up, with the token-trouble code');
    assert.match((await callTool('foundry_status', {}, bearer(TOKEN))).content[0].text, /not connected/);
  });

  await check('a relay cannot change the world the module reported', async () => {
    // The proof is computed over "test-world", but the hello that reaches the hub says otherwise.
    assert.deepEqual(await rawSocket(TOKEN_PORT, ORIGIN, TOKEN, { claimedWorld: 'another-world' }), { outcome: 'closed', code: 4003 });
  });

  await check('a relay cannot move text between the fields the module reported', async () => {
    // Joined with line breaks, these two hellos are the same text, so the module's proof fits both.
    const reported = { world: 'test-world\nx', core: 'x', system: '14', session: 'sess' };
    const relayed = { world: 'test-world', core: 'x', system: 'x', session: '14\nsess' };
    assert.equal(bindingOf({ nonce: 'abc', protocol: 5, ...reported }, 'n'), bindingOf({ nonce: 'abc', protocol: 5, ...relayed }, 'n'));
    assert.deepEqual(await rawSocket(TOKEN_PORT, ORIGIN, TOKEN, { reported, relayed }), { outcome: 'closed', code: 4002 });
    assert.deepEqual(await rawSocket(TOKEN_PORT, ORIGIN, TOKEN, { reported }), { outcome: 'closed', code: 4002 });
  });

  await check('a module with the token proves itself, checks the hub, and then works', async () => {
    // Something prints the token during world start-up, before the module has read its own setting.
    await startModule(`ws://127.0.0.1:${TOKEN_PORT}/foundry`, TOKEN, () => console.error(`startup leak ${TOKEN} end`));
    const startup = payload(await callTool('foundry_logs', { contains: 'startup leak' }, bearer(TOKEN)));
    assert.deepEqual(startup.entries.map((e) => e.text), ['startup leak [redacted] end']);
    assert.equal((await evalCode('return 40 + 2', {}, bearer(TOKEN))).result, 42);
    // Signed commands keep working in sequence, and the hub token is scrubbed from output.
    const reply = await evalCode(`console.log('leaked ${TOKEN} here'); return 'second';`, {}, bearer(TOKEN));
    assert.equal(reply.result, 'second');
    assert.deepEqual(reply.logs, [{ level: 'log', text: 'leaked [redacted] here' }]);
    // A signed cancel reaches the code it refers to, even though it is a much shorter message than the eval.
    const padding = '/* ' + 'x'.repeat(200_000) + ' */';
    const slow = await callTool('foundry_eval', { code: `${padding} await new Promise((r) => signal.addEventListener('abort', r)); globalThis.signedCancel = true;`, timeoutMs: 1000 }, bearer(TOKEN));
    assert.match(slow.content[0].text, /Timed out/);
    await sleep(300);
    assert.equal((await evalCode('return globalThis.signedCancel === true', {}, bearer(TOKEN))).result, true);
  });

  // A stand-in hub, for behaviour the real hub never shows. `wrongProof` answers the challenge
  // without knowing the token; otherwise it completes the handshake honestly and then sends an
  // unsigned command, as something sitting between the module and the real hub would.
  const fakeHub = async ({ wrongProof, replay, badId }) => {
    const fake = new WebSocketServer({ port: FAKE_PORT, host: '127.0.0.1' });
    const closed = new Promise((resolve) => {
      fake.on('connection', (ws) => {
        let hello;
        ws.on('close', (code) => resolve(code));
        ws.on('message', (data) => {
          const msg = JSON.parse(data);
          if (msg.hello) {
            hello = msg.hello;
            const proof = wrongProof ? '00'.repeat(32) : sign(TOKEN, `hub\n${bindingOf(msg.hello, 'hubnonce')}`).toString('hex');
            ws.send(JSON.stringify({ challenge: { nonce: 'hubnonce', proof } }));
          } else if (msg.proof) {
            ws.send(JSON.stringify({ welcome: true }));
            const key = sign(TOKEN, `session\n${bindingOf(hello, 'hubnonce')}`);
            const signed = (id, code) => JSON.stringify({ id, method: 'eval', params: { code }, seq: 1, mac: sign(key, JSON.stringify([1, 'eval', id, code])).toString('hex') });
            if (replay) {
              // One genuinely signed command, sent twice.
              const command = signed(randomUUID(), 'globalThis.replayed = (globalThis.replayed ?? 0) + 1;');
              ws.send(command);
              ws.send(command);
            } else if (badId) {
              // Correctly signed, but the id is not a UUID: the shape a field-shifting relay would need.
              ws.send(signed('not-a-uuid\nreturn;', 'globalThis.injected = true;'));
            } else ws.send(JSON.stringify({ id: randomUUID(), method: 'eval', params: { code: 'globalThis.injected = true;' }, seq: 1, mac: '00' }));
          }
        });
      });
    });
    await startModule(`ws://127.0.0.1:${FAKE_PORT}/foundry`, TOKEN);
    const code = await closed;
    await new Promise((resolve) => fake.close(resolve));
    return code;
  };

  await check('a module refuses a hub whose proof is wrong, and sends it nothing more', async () => {
    assert.equal(await fakeHub({ wrongProof: true }), 4003);
    assert.equal(globalThis.injected, undefined);
  });

  await check('a module refuses a command the hub did not sign', async () => {
    assert.equal(await fakeHub({ wrongProof: false }), 4003);
    assert.equal(globalThis.injected, undefined);
  });
  await check('a module refuses a command whose id is not a plain UUID, signed or not', async () => {
    assert.equal(await fakeHub({ badId: true }), 4003);
    assert.equal(globalThis.injected, undefined);
  });

  await check('a module runs a signed command once and refuses its replay', async () => {
    assert.equal(await fakeHub({ replay: true }), 4003);
    assert.equal(globalThis.replayed, 1);
  });

  await check('a module with a token refuses a hub that cannot prove it knows the token', async () => {
    // BARE_PORT has no token, as a program squatting on the hub port would not.
    await startModule(`ws://127.0.0.1:${BARE_PORT}/foundry`, TOKEN);
    assert.equal(moduleSockets.at(-1).closeCode, 4003);
    assert.match((await callTool('foundry_status', {}, { port: BARE_PORT })).content[0].text, /not connected/);
  });

  // ----------------------------------------------------------------- options
  await check('allowEval: false removes foundry_eval and keeps the read-only tools working', async () => {
    assert.deepEqual(await toolNames({ port: READ_PORT }), ['foundry_status', 'foundry_documents', 'foundry_document', 'foundry_settings', 'foundry_changes', 'foundry_logs']);
    await startModule(`ws://127.0.0.1:${READ_PORT}/foundry`, '');
    assert.equal(payload(await callTool('foundry_documents', { type: 'Actor' }, { port: READ_PORT })).result.total, 2);
    const refused = await mcp('tools/call', { name: 'foundry_eval', arguments: { code: 'globalThis.ranWithoutEval = true' } }, { port: READ_PORT });
    assert.ok(refused.error || refused.result?.isError, 'foundry_eval is not callable');
    assert.equal(globalThis.ranWithoutEval, undefined);
  });

  await check('allowRead: false removes the document and settings tools', async () => {
    assert.deepEqual(await toolNames({ port: BARE_PORT }), ['foundry_status', 'foundry_logs']);
    const refused = await mcp('tools/call', { name: 'foundry_settings', arguments: {} }, { port: BARE_PORT });
    assert.ok(refused.error || refused.result?.isError, 'foundry_settings is not callable');
  });

  await check('the manifest, the hub package and the MCP server agree on the version, and the manifest installs that release', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../foundry-mcp/module.json', import.meta.url), 'utf8'));
    const hub = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    assert.equal(hub.version, manifest.version);
    const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8'));
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.ok(readFileSync(new URL('./index.js', import.meta.url), 'utf8').includes(`name: 'foundry', version: '${manifest.version}'`));
    assert.equal(manifest.manifest, `${manifest.url}/releases/latest/download/module.json`);
    assert.equal(manifest.download, `${manifest.url}/releases/download/v${manifest.version}/module.zip`);
  });

  await check('a hub whose config has no token creates one, protects the file, and runs code nowhere by default', async () => {
    const generated = JSON.parse(readFileSync(freshConfig, 'utf8')).token;
    assert.ok(generated.length >= 32);
    // The config was world-readable before the token was added (0644), as a copied example would be.
    if (process.platform !== 'win32') assert.equal(statSync(freshConfig).mode & 0o077, 0, 'config is private after the token is written');
    assert.deepEqual(readdirSync(tmp).filter((name) => name.endsWith('.tmp')), [], 'no temporary token file is left behind');
    const auth = { port: FRESH_PORT, headers: { authorization: `Bearer ${generated}` } };
    assert.equal((await mcp('tools/list', {}, { port: FRESH_PORT })).status, 401);
    assert.equal((await toolNames(auth)).length, 8);
    // An authenticated module in a world, with nothing on the allowlist: connected, but no code runs.
    await startModule(`ws://127.0.0.1:${FRESH_PORT}/foundry`, generated);
    assert.equal((await getLogsFrom(auth)).connected, false, 'a world that is not allowed never becomes the connected world');
    const refused = await callTool('foundry_eval', { code: 'globalThis.ranAnyway = true; return 1' }, auth);
    assert.match(refused.content[0].text, /not on this hub's allowlist/);
    assert.equal(globalThis.ranAnyway, undefined);
    const result = await callTool('foundry_status', {}, auth);
    assert.equal(result.isError, true);
  });

  await check('a configuration with a wrong type stops the hub instead of weakening it', async () => {
    const start = (name, content, env = {}) => {
      const file = join(tmp, name);
      if (content !== undefined) writeFileSync(file, content);
      const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FOUNDRY_MCP_')));
      const run = spawnSync(process.execPath, ['index.js'], {
        cwd: import.meta.dirname,
        env: { ...base, FOUNDRY_MCP_CONFIG: file, FOUNDRY_MCP_PORT: '30193', ...env },
        encoding: 'utf8',
        timeout: 5000,
      });
      return { status: run.status, stderr: run.stderr };
    };
    for (const [name, content, expected] of [
      ['eval-string.json', '{ "token": "", "allowEval": "false" }', /"allowEval" must be true or false/],
      ['token-number.json', '{ "token": 5 }', /"token" must be text/],
      ['eval-null.json', '{ "token": "", "allowEval": null }', /"allowEval" must be true or false/],
      ['read-string.json', '{ "token": "", "allowRead": "false" }', /"allowRead" must be true or false/],
      ['worlds-null.json', '{ "token": "", "worlds": null }', /"worlds" must be a list/],
      ['token-short.json', '{ "token": "abc" }', /too short/],
      ['limit.json', '{ "token": "", "logLimit": "not-a-number" }', /"logLimit" must be/],
      ['worlds.json', '{ "token": "", "worlds": "my-world" }', /"worlds" must be a list/],
      ['broken.json', '{ not json', /Cannot read/],
      // Values that used to start a hub which then silently refused everything, or silently ran unprotected.
      ['origin-star.json', '{ "token": "", "origins": ["*"] }', /"origins" does not support "\*"/],
      ['origin-path.json', '{ "token": "", "origins": ["http://localhost:30000/game"] }', /only the scheme, host and port/],
      ['token-blank.json', '{ "token": "   " }', /"token" is blank/],
      ['token-newline.json', '{ "token": "abcdefgh12345678\\nijklmnop" }', /line break or control character/],
      ['limit-huge.json', '{ "token": "", "logLimit": 5000000 }', /"logLimit" must be a whole number from 1 to 10000/],
    ]) {
      const run = start(name, content);
      assert.equal(run.status, 1, name);
      assert.match(run.stderr, expected, name);
    }
    assert.match(start('env.json', '{ "token": "" }', { FOUNDRY_MCP_ALLOW_EVAL: 'maybe' }).stderr, /"allowEval" must be true or false/);
    assert.match(start('env.json', '{ "token": "" }', { FOUNDRY_MCP_ALLOW_READ: '0' }).stderr, /"allowRead" must be true or false/);
    assert.match(start('env.json', undefined, { FOUNDRY_MCP_PORT: 'abc' }).stderr, /"port" must be/);
  });

  await check('a config file that cannot be saved or made private stops the hub', async () => {
    // What happens when the file or its folder belongs to another account, simulated by a preload.
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FOUNDRY_MCP_')));
    const start = (name, content, fault) => {
      const file = join(tmp, name);
      writeFileSync(file, content);
      return spawnSync(process.execPath, ['--import', new URL('./test-fixtures/fault-fs.mjs', import.meta.url).href, 'index.js'], {
        cwd: import.meta.dirname,
        env: { ...base, FOUNDRY_MCP_CONFIG: file, FOUNDRY_MCP_PORT: '30193', FAULT_FS: fault },
        encoding: 'utf8',
        timeout: 5000,
      });
    };
    const unsaved = start('unsaved.json', '{ "worlds": [] }', 'write');
    assert.equal(unsaved.status, 1);
    assert.match(unsaved.stderr, /Cannot save a new token/);
    assert.equal(readFileSync(join(tmp, 'unsaved.json'), 'utf8'), '{ "worlds": [] }', 'the old settings survive');
    assert.deepEqual(readdirSync(tmp).filter((name) => name.endsWith('.tmp')), []);
    // Windows has no file modes, so the hub does not try to change them there.
    if (process.platform !== 'win32') {
      const exposed = start('exposed.json', '{ "token": "abcdefgh12345678ijkl" }', 'chmod');
      assert.equal(exposed.status, 1);
      assert.match(exposed.stderr, /holds the hub token but could not be made private/);
    }
  });

  await check('starting a second hub on a port in use explains the problem', async () => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FOUNDRY_MCP_')));
    const run = spawnSync(process.execPath, ['index.js'], {
      cwd: import.meta.dirname,
      env: { ...base, FOUNDRY_MCP_CONFIG: join(tmp, 'none.json'), FOUNDRY_MCP_PORT: String(PORT), FOUNDRY_MCP_TOKEN: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Port 30199 is already in use/);
    assert.doesNotMatch(run.stderr, /Unhandled 'error' event/);
  });

  await check('a player\'s browser never connects', async () => {
    const before = moduleSockets.length;
    game.user.isGM = false;
    await startModule(`ws://127.0.0.1:${BARE_PORT}/foundry`, '');
    game.user.isGM = true;
    assert.equal(moduleSockets.length, before);
  });

  await check('code that outlives its timeout still counts against the limit, in the browser', async () => {
    // Sixteen calls that never finish and ignore the abort signal. This runs last: those slots stay taken.
    const stuck = await Promise.all(
      Array.from({ length: 16 }, () => callTool('foundry_eval', { code: 'await new Promise(() => {});', timeoutMs: 1000 }, bearer(TOKEN)))
    );
    assert.ok(stuck.every((r) => /Timed out/.test(r.content[0].text)));
    const next = await callTool('foundry_eval', { code: 'return 1' }, bearer(TOKEN));
    assert.equal(next.isError, true);
    assert.match(next.content[0].text, /still running in Foundry/);
  });

  console.log(`\nALL ${passed} CHECKS PASSED (simulated Foundry)`);
} catch (error) {
  console.error(`\nFAILED after ${passed} passing checks:\n`, error);
  process.exitCode = 1;
} finally {
  for (const hub of hubs) hub.kill();
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
  process.exit();
}
