// End-to-end checks without Foundry: starts the hub, loads the real module
// script against stubbed Foundry globals, and calls the tools over MCP HTTP.
// Everything here is simulated; see README "Verifying against a real world".
// Run with: npm test   (takes about 25 s because it waits out real reconnects)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 30199;
const TOKEN_PORT = 30198;
const ORIGIN = 'http://localhost:30000';

function startHub(env) {
  return spawn(process.execPath, ['index.js'], {
    cwd: import.meta.dirname,
    // Point at a config file that does not exist so a local config.json is never read.
    env: { ...process.env, FOUNDRY_MCP_CONFIG: 'none.json', FOUNDRY_MCP_WORLDS: 'test-world', ...env },
    stdio: 'inherit',
  });
}
const hubs = [
  startHub({ FOUNDRY_MCP_PORT: PORT, FOUNDRY_MCP_LOG_LIMIT: 60 }),
  startHub({ FOUNDRY_MCP_PORT: TOKEN_PORT, FOUNDRY_MCP_TOKEN: 'correct-horse' }),
];

async function mcp(method, params, headers = {}, port = PORT) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  if (!response.ok) return { status: response.status, text };
  // The reply is either plain JSON or a one-event SSE stream.
  const json = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data:')).slice(5);
  return JSON.parse(json);
}
const callTool = async (name, args = {}) => (await mcp('tools/call', { name, arguments: args })).result;
const payload = (result) => JSON.parse(result.content[0].text);
const evalCode = async (code, extra = {}) => payload(await callTool('foundry_eval', { code, ...extra }));
const getLogs = async (args = {}) => payload(await callTool('foundry_logs', args));

// --- Stub the slice of Foundry and the browser the module touches.
const hooks = {};
const settings = { 'foundry-mcp.url': 'ws://evil.example:30199/foundry', 'foundry-mcp.token': '' };
const actor = { name: 'Test Actor', flags: {}, toObject() { return { name: this.name, flags: this.flags }; } };
globalThis.Hooks = { once: (name, fn) => (hooks[name] = fn) };
globalThis.game = {
  settings: { register() {}, get: (module, key) => settings[`${module}.${key}`] },
  user: { isGM: true, name: 'Gamemaster' },
  world: { id: 'test-world', title: 'Test World' },
  system: { id: 'some-system', title: 'Some System', version: '1.0.0' },
  version: '14.370',
  actors: Object.assign(new Map([['a1', actor]]), { getName: () => actor }),
  items: new Map(), scenes: Object.assign(new Map(), { active: null }), macros: new Map(), journal: new Map(),
  modules: [{ id: 'foundry-mcp', version: '0.2.0', active: true }],
};
globalThis.canvas = { scene: null };
globalThis.window = new EventTarget();
globalThis.location = { origin: ORIGIN };
const NodeWebSocket = globalThis.WebSocket;
const moduleSockets = [];
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(url) {
    super(url, { headers: { origin: ORIGIN } });
    moduleSockets.push(this);
  }
};
// A raw socket for playing a second tab or a hostile page.
function rawSocket(port, origin, hello) {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/foundry`, { headers: { origin } });
  return new Promise((resolve) => {
    ws.addEventListener('open', () => hello && ws.send(JSON.stringify({ hello })));
    ws.addEventListener('message', (event) => resolve({ ws, outcome: 'welcomed', message: JSON.parse(event.data) }));
    ws.addEventListener('close', (event) => resolve({ outcome: 'closed', code: event.code }));
    ws.addEventListener('error', () => resolve({ outcome: 'rejected' }));
  });
}
const hello = { protocol: 2, session: 's', world: 'test-world', user: 'x', core: '14', system: 'y' };
const fixture = await import('./test-fixtures/modules/fake-automation/scripts/workflow.js');
globalThis.fakeAutomation = fixture;

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

try {
  await sleep(1000);
  await import('../foundry-mcp/scripts/bridge.js');
  hooks.init();

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

  await check('lists the three tools', async () => {
    const tools = (await mcp('tools/list', {})).result.tools.map((t) => t.name);
    assert.deepEqual(tools, ['foundry_status', 'foundry_eval', 'foundry_logs']);
  });

  await check('status reports world and system without assuming dnd5e', async () => {
    const status = payload(await callTool('foundry_status')).result;
    assert.equal(status.world, 'test-world');
    assert.equal(status.system, 'some-system');
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

  await check('eval serializes awkward values', async () => {
    const reply = await evalCode(`const o = { big: 10n, when: new Date(0), set: new Set([1]) }; o.self = o; return o;`);
    assert.deepEqual(reply.result, { big: '10', when: '1970-01-01T00:00:00.000Z', set: [1], self: '[Circular]' });
  });

  await check('eval times out without hanging the hub', async () => {
    const result = await callTool('foundry_eval', { code: `await new Promise(() => {});`, timeoutMs: 1000 });
    assert.match(result.content[0].text, /Timed out/);
  });

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

  await check('credentials are redacted before leaving the browser', async () => {
    const before = (await getLogs()).lastSeq;
    console.error('login failed password=hunter22 api_key: "abc123" Authorization: Bearer abcdefgh12345678 cobalt-token=zzz999 Token Goblin is fine');
    console.warn('blob ' + 'A1b2'.repeat(12));
    await sleep(200);
    const texts = (await getLogs({ since: before })).entries.map((e) => e.text);
    assert.deepEqual(texts, [
      'login failed password=[redacted] api_key: "[redacted]" Authorization: [redacted] [redacted] cobalt-token=[redacted] Token Goblin is fine',
      'blob [redacted]',
    ]);
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

  await check('a repeating error collapses into one entry with a count', async () => {
    const before = (await getLogs()).lastSeq;
    for (let i = 0; i < 5; i++) console.warn('same thing again');
    await sleep(200);
    const logs = await getLogs({ since: before });
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0].count, 5);
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

  await check('a second GM tab is turned away while the first is connected', async () => {
    assert.deepEqual(await rawSocket(PORT, ORIGIN, hello), { outcome: 'closed', code: 4001 });
  });

  await check('a web page cannot call the MCP endpoint', async () => {
    assert.equal((await mcp('tools/list', {}, { origin: 'https://evil.example' })).status, 403);
  });

  await check('a page from another origin cannot pose as Foundry', async () => {
    assert.equal((await rawSocket(PORT, 'https://evil.example', hello)).outcome, 'rejected');
  });

  await check('with a hub token set, MCP calls and the module both need it', async () => {
    assert.equal((await mcp('tools/list', {}, {}, TOKEN_PORT)).status, 401);
    assert.equal((await mcp('tools/list', {}, { authorization: 'Bearer wrong' }, TOKEN_PORT)).status, 401);
    const ok = await mcp('tools/list', {}, { authorization: 'Bearer correct-horse' }, TOKEN_PORT);
    assert.equal(ok.result.tools.length, 3);
    assert.deepEqual(await rawSocket(TOKEN_PORT, ORIGIN, { ...hello, token: 'wrong' }), { outcome: 'closed', code: 4003 });
    const good = await rawSocket(TOKEN_PORT, ORIGIN, { ...hello, token: 'correct-horse' });
    assert.equal(good.outcome, 'welcomed');
    good.ws.close();
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
  });

  console.log(`\nALL ${passed} CHECKS PASSED (simulated Foundry)`);
} finally {
  for (const hub of hubs) hub.kill();
  setTimeout(() => process.exit(), 100);
}
