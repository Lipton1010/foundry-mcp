// End-to-end checks without Foundry: starts hubs, loads the real module script
// against stubbed Foundry globals, and calls the tools over MCP HTTP.
// Everything here is simulated; see README "Verifying against a real world".
// Run with: npm test   (takes about 40 s because it waits out real reconnects)

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const PORT = 30199; // no token, small log buffer
const TOKEN_PORT = 30198; // token required
const BARE_PORT = 30197; // no token, eval disabled, nothing connected: stands in for an impostor hub
const FRESH_PORT = 30196; // a config copied from the example: no token, no worlds, world-readable
const FAKE_PORT = 30195; // a hand-rolled hub that knows the token but sends an unsigned command
const TOKEN = 'correct-horse-battery';
const ORIGIN = 'http://localhost:30000';
const tmp = mkdtempSync(join(tmpdir(), 'foundry-mcp-test-'));
const freshConfig = join(tmp, 'config.json');
writeFileSync(freshConfig, '{ "worlds": [] }');
chmodSync(freshConfig, 0o644);

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
  startHub({ FOUNDRY_MCP_PORT: TOKEN_PORT, FOUNDRY_MCP_TOKEN: `${TOKEN} ` }), // trailing space, as a shell can add
  startHub({ FOUNDRY_MCP_PORT: BARE_PORT, FOUNDRY_MCP_TOKEN: '', FOUNDRY_MCP_ALLOW_EVAL: 'false' }),
  startHub({ FOUNDRY_MCP_PORT: FRESH_PORT, FOUNDRY_MCP_CONFIG: freshConfig, FOUNDRY_MCP_WORLDS: '' }),
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
  modules: [{ id: 'foundry-mcp', version: '0.4.0', active: true }],
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
const sign = (key, text) => createHmac('sha256', key).update(text).digest();
const bindingOf = (hello, hubNonce) => [hello.nonce, hubNonce, hello.protocol, hello.world, hello.core, hello.system, hello.session].join('\n');
function rawSocket(port, origin, token, { firstMessage, claimedWorld } = {}) {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/foundry`, { headers: { origin } });
  const hello = { protocol: 5, session: 's', world: 'test-world', core: '14', system: 'y', nonce: 'abc' };
  return new Promise((resolve) => {
    ws.addEventListener('open', () => ws.send(firstMessage ?? JSON.stringify({ hello: { ...hello, world: claimedWorld ?? hello.world } })));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.challenge) {
        const expected = sign(TOKEN, `hub\n${bindingOf({ ...hello, world: claimedWorld ?? hello.world }, msg.challenge.nonce)}`).toString('hex');
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

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

try {
  // Wait until every hub answers instead of guessing how long start-up takes.
  for (const port of [PORT, TOKEN_PORT, BARE_PORT, FRESH_PORT]) {
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
      return 80_000 + Number(text.match(/truncated (\d+) chars/)[1]);
    };
    assert.ok((await sentChars(`return 'x'.repeat(1_000_000);`)) < 450_000, 'long strings are cut');
    assert.ok((await sentChars(`return Array.from({ length: 100_001 }, (_, i) => 100_000 + i);`)) < 600_000, 'long lists are cut');
    assert.ok((await sentChars(`return new Set(Array.from({ length: 100_001 }, (_, i) => 100_000 + i));`)) < 600_000, 'long sets are cut');
    assert.ok((await sentChars(`return { ['k'.repeat(1_000_000)]: 1 };`)) < 450_000, 'long keys are cut');
    assert.ok((await sentChars(`return { toObject: () => 'x'.repeat(1_000_000) };`)) < 450_000, 'text from toObject() is cut');
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

  await check('clients that open with an MCP initialize handshake are served', async () => {
    const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'foundry');
    assert.match(init.result.instructions, /foundry_status first/);
  });

  await check('the official MCP client connects, lists the tools and calls one', async () => {
    const client = new Client({ name: 'foundry-mcp-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['foundry_status', 'foundry_eval', 'foundry_logs']);
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
    assert.equal((await toolNames(bearer(TOKEN))).length, 3);
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
  await check('allowEval: false removes foundry_eval and nothing else', async () => {
    assert.deepEqual(await toolNames({ port: BARE_PORT }), ['foundry_status', 'foundry_logs']);
  });

  await check('a hub whose config has no token creates one, protects the file, and runs code nowhere by default', async () => {
    const generated = JSON.parse(readFileSync(freshConfig, 'utf8')).token;
    assert.ok(generated.length >= 32);
    // The config was world-readable before the token was added (0644), as a copied example would be.
    if (process.platform !== 'win32') assert.equal(statSync(freshConfig).mode & 0o077, 0, 'config is private after the token is written');
    assert.deepEqual(readdirSync(tmp).filter((name) => name.endsWith('.tmp')), [], 'no temporary token file is left behind');
    const auth = { port: FRESH_PORT, headers: { authorization: `Bearer ${generated}` } };
    assert.equal((await mcp('tools/list', {}, { port: FRESH_PORT })).status, 401);
    assert.equal((await toolNames(auth)).length, 3);
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
      ['worlds-null.json', '{ "token": "", "worlds": null }', /"worlds" must be a list/],
      ['token-short.json', '{ "token": "abc" }', /too short/],
      ['limit.json', '{ "token": "", "logLimit": "not-a-number" }', /"logLimit" must be/],
      ['worlds.json', '{ "token": "", "worlds": "my-world" }', /"worlds" must be a list/],
      ['broken.json', '{ not json', /Cannot read/],
    ]) {
      const run = start(name, content);
      assert.equal(run.status, 1, name);
      assert.match(run.stderr, expected, name);
    }
    assert.match(start('env.json', '{ "token": "" }', { FOUNDRY_MCP_ALLOW_EVAL: 'maybe' }).stderr, /"allowEval" must be true or false/);
    assert.match(start('env.json', undefined, { FOUNDRY_MCP_PORT: 'abc' }).stderr, /"port" must be/);
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
