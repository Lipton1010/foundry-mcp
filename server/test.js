// End-to-end checks without Foundry: starts hubs, loads the real module script
// against stubbed Foundry globals, and calls the tools over MCP HTTP.
// Everything here is simulated; see README "Verifying against a real world".
// Run with: npm test   (takes about 40 s because it waits out real reconnects)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket as NodeWebSocket } from 'ws';

const PORT = 30199; // no token, small log buffer
const TOKEN_PORT = 30198; // token required
const BARE_PORT = 30197; // no token, eval disabled, nothing connected: stands in for an impostor hub
const FRESH_PORT = 30196; // no configuration at all
const TOKEN = 'correct-horse-battery';
const ORIGIN = 'http://localhost:30000';
const tmp = mkdtempSync(join(tmpdir(), 'foundry-mcp-test-'));
const freshConfig = join(tmp, 'config.json');

function startHub(env) {
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith('FOUNDRY_MCP_')) delete base[key];
  return spawn(process.execPath, ['index.js'], {
    cwd: import.meta.dirname,
    // Point at a config file that does not exist so a local config.json is never read.
    env: { ...base, FOUNDRY_MCP_CONFIG: join(tmp, 'none.json'), FOUNDRY_MCP_WORLDS: 'test-world', ...env },
    stdio: 'inherit',
  });
}
const hubs = [
  startHub({ FOUNDRY_MCP_PORT: PORT, FOUNDRY_MCP_TOKEN: '', FOUNDRY_MCP_LOG_LIMIT: 60 }),
  startHub({ FOUNDRY_MCP_PORT: TOKEN_PORT, FOUNDRY_MCP_TOKEN: TOKEN }),
  startHub({ FOUNDRY_MCP_PORT: BARE_PORT, FOUNDRY_MCP_TOKEN: '', FOUNDRY_MCP_ALLOW_EVAL: 'false' }),
  startHub({ FOUNDRY_MCP_PORT: FRESH_PORT, FOUNDRY_MCP_CONFIG: freshConfig, FOUNDRY_MCP_WORLDS: undefined }),
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
const toolNames = async (options) => (await mcp('tools/list', {}, options)).result.tools.map((t) => t.name);

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
  modules: [{ id: 'foundry-mcp', version: '0.3.0', active: true }],
};
globalThis.canvas = { scene: null };
globalThis.window = new EventTarget();
globalThis.location = { origin: ORIGIN };
// The browser's WebSocket, played by the `ws` client (Node 20 has none built in),
// which also lets the test set the Origin header a browser would send.
const moduleSockets = [];
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(url) {
    super(url, { headers: { origin: ORIGIN } });
    moduleSockets.push(this);
  }
};
// Loads another copy of the real module script, as a second browser tab would.
let copies = 0;
async function startModule(url, token) {
  settings['foundry-mcp.url'] = url;
  settings['foundry-mcp.token'] = token;
  await import(`../foundry-mcp/scripts/bridge.js?copy=${++copies}`);
  hooks.init();
  hooks.ready();
  await sleep(600);
}
// A hand-rolled socket for playing a second tab, a hostile page, or a client with the wrong token.
function rawSocket(port, origin, token) {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/foundry`, { headers: { origin } });
  const sign = (text) => createHmac('sha256', token ?? '').update(text).digest('hex');
  return new Promise((resolve) => {
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ hello: { protocol: 3, session: 's', world: 'test-world', core: '14', system: 'y', nonce: 'abc' } }))
    );
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.challenge) {
        const hubKnowsToken = msg.challenge.proof === createHmac('sha256', TOKEN).update(`hub:abc:${msg.challenge.nonce}`).digest('hex');
        assert.ok(hubKnowsToken, 'the hub proves it knows the token');
        ws.send(JSON.stringify({ proof: sign(`module:abc:${msg.challenge.nonce}`) }));
      } else resolve({ ws, outcome: msg.welcome ? 'welcomed' : 'other' });
    });
    ws.addEventListener('close', (event) => resolve({ outcome: 'closed', code: event.code }));
    ws.addEventListener('error', () => resolve({ outcome: 'rejected' }));
  });
}
const fixture = await import('./test-fixtures/modules/fake-automation/scripts/workflow.js');
globalThis.fakeAutomation = fixture;

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

try {
  await sleep(1500);
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

  await check('lists the three tools', async () => {
    assert.deepEqual(await toolNames(), ['foundry_status', 'foundry_eval', 'foundry_logs']);
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
    const replies = await Promise.all(
      Array.from({ length: 17 }, (_, i) => callTool('foundry_eval', { code: `await new Promise((r) => setTimeout(r, 800)); return ${i};` }))
    );
    const refused = replies.filter((r) => r.isError);
    assert.equal(refused.length, 1);
    assert.match(refused[0].content[0].text, /already running/);
    assert.deepEqual(replies.filter((r) => !r.isError).map((r) => payload(r).result), Array.from({ length: 16 }, (_, i) => i));
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
    const secrets =
      'login failed password=hunter22 api_key: "abc123" Authorization: Bearer abcdefgh12345678 cobalt-token=zzz999 ' +
      'https://example.test/hook?user=bob&token=qwerty123&x=1 Token Goblin is fine';
    const expected =
      'login failed password=[redacted] api_key: "[redacted]" Authorization: [redacted] [redacted] cobalt-token=[redacted] ' +
      'https://example.test/hook?user=bob&token=[redacted]&x=1 Token Goblin is fine';
    console.error(secrets);
    console.warn('blob ' + 'A1b2'.repeat(12));
    console.warn('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl');
    await sleep(200);
    assert.deepEqual((await getLogs({ since: before })).entries.map((e) => e.text), [expected, 'blob [redacted]', 'jwt [redacted]']);
    const reply = await evalCode(`console.log(${JSON.stringify(secrets)}); return 1;`);
    assert.deepEqual(reply.logs, [{ level: 'log', text: expected }]);
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
  });

  await check('a page from another origin cannot pose as Foundry', async () => {
    assert.equal((await rawSocket(PORT, 'https://evil.example')).outcome, 'rejected');
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
    game.world.id = 'test-world';
  });

  // ------------------------------------------------------------------- token
  await check('a hub with a token refuses MCP calls without it', async () => {
    assert.equal((await mcp('tools/list', {}, { port: TOKEN_PORT })).status, 401);
    assert.equal((await mcp('tools/list', {}, bearer('wrong'))).status, 401);
    assert.equal((await toolNames(bearer(TOKEN))).length, 3);
  });

  await check('a module without the right token cannot connect to a token hub', async () => {
    assert.deepEqual(await rawSocket(TOKEN_PORT, ORIGIN, 'wrong'), { outcome: 'closed', code: 4003 });
    const before = moduleSockets.length;
    await startModule(`ws://127.0.0.1:${TOKEN_PORT}/foundry`, ''); // real module, no token configured
    assert.equal(moduleSockets.length, before + 1);
    assert.match((await callTool('foundry_status', {}, bearer(TOKEN))).content[0].text, /not connected/);
  });

  await check('a module with the token proves itself, checks the hub, and then works', async () => {
    await startModule(`ws://127.0.0.1:${TOKEN_PORT}/foundry`, TOKEN);
    assert.equal((await evalCode('return 40 + 2', {}, bearer(TOKEN))).result, 42);
  });

  await check('a module with a token refuses a hub that cannot prove it knows the token', async () => {
    // BARE_PORT has no token, as a program squatting on the hub port would not.
    await startModule(`ws://127.0.0.1:${BARE_PORT}/foundry`, TOKEN);
    assert.match((await callTool('foundry_status', {}, { port: BARE_PORT })).content[0].text, /not connected/);
  });

  // ----------------------------------------------------------------- options
  await check('allowEval: false removes foundry_eval and nothing else', async () => {
    assert.deepEqual(await toolNames({ port: BARE_PORT }), ['foundry_status', 'foundry_logs']);
  });

  await check('a hub started with no configuration creates a token and requires it', async () => {
    assert.ok(existsSync(freshConfig));
    const generated = JSON.parse(readFileSync(freshConfig, 'utf8')).token;
    assert.ok(generated.length >= 32);
    assert.equal((await mcp('tools/list', {}, { port: FRESH_PORT })).status, 401);
    assert.equal((await toolNames({ port: FRESH_PORT, headers: { authorization: `Bearer ${generated}` } })).length, 3);
    // With no worlds configured, even an authenticated call cannot run code.
    const result = await callTool('foundry_status', {}, { port: FRESH_PORT, headers: { authorization: `Bearer ${generated}` } });
    assert.equal(result.isError, true);
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
