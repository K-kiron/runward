import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from '../public/connection.mjs';
import { createServer } from '../server.mjs';

// Controlled transport fixtures exercise ordering without real accounts or network access.
const domain = { id: 'synthetic-personal', environmentId: 'synthetic-laptop' };
const rootToken = 'synthetic-root-token';
const sessionToken = 'synthetic-session-token';
const sessionBody = (extra = {}) => ({ readable: true, writable: true, domain, instanceId: 'launch-a', sessionToken, ...extra });
const snapshot = (extra = {}) => ({ domain, instanceId: 'launch-a', revision: 1,
  agents: [], events: [], runs: [], handoffs: [], attention: [], ...extra });
const json = (body, status = 200) => Response.json(body, { status });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function eventStream() {
  let controller;
  let cancelled = false;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    send(text) { controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text); },
    state(value) { this.send(`event: state\ndata: ${JSON.stringify(value)}\n\n`); },
    close() { controller.close(); },
    get cancelled() { return cancelled; },
  };
}
function fixture(t, overrides = {}, settings = {}) {
  const calls = [];
  const states = [];
  const accesses = [];
  const statuses = [];
  const timers = new Map();
  let timerId = 0;
  const stream = eventStream();
  const handlers = {
    'POST /api/session': () => json(sessionBody()),
    'DELETE /api/session': () => json({ ok: true }),
    'GET /api/state': () => json(snapshot()),
    'GET /api/stream': () => stream.response,
    'POST /api/actions': () => json({ ok: true }),
    ...overrides,
  };
  const connection = createConnection({
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      const handler = handlers[`${options.method ?? 'GET'} ${url}`];
      assert.ok(handler, `Unexpected route ${url}`);
      return handler(options);
    },
    onState: value => states.push(value), onAccess: value => accesses.push(value), onStatus: value => statuses.push(value),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    ...settings,
  });
  t.after(() => connection.logout());
  return { connection, calls, states, accesses, statuses, timers, handlers, stream,
    async retry() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); await settle(); } };
}

test('locked controller performs no reads; exchange uses root only once and later routes use session headers', async t => {
  const f = fixture(t);
  assert.equal(await f.connection.refresh(), false);
  assert.equal(await f.connection.action({}), false);
  assert.equal(f.calls.length, 0);
  const access = await f.connection.login(rootToken);
  await settle();
  assert.deepEqual(access, { readable: true, writable: true, domain, instanceId: 'launch-a' });
  assert.equal(f.states.at(-1).revision, 1);
  assert.equal(f.statuses.at(-1).phase, 'live');
  assert.equal(await f.connection.action({ type: 'attention.resolve', data: { id: 'synthetic-item' } }), true);
  f.connection.logout();
  await settle();
  assert.deepEqual(f.calls.map(call => call.url), ['/api/session', '/api/state', '/api/stream', '/api/actions', '/api/session']);
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.headers.Authorization, `Bearer ${index === 0 ? rootToken : sessionToken}`);
    assert.equal(call.credentials, 'omit');
    assert.equal(call.redirect, 'error');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.referrerPolicy, 'no-referrer');
    assert.equal(call.url.includes('?'), false);
    assert.equal(call.url.includes('token'), false);
  }
  assert.equal(JSON.stringify(f.accesses).includes(sessionToken), false);
  assert.equal(JSON.stringify(f.states).includes(rootToken), false);
  assert.equal(f.stream.cancelled, true);
});

test('logout immediately clears data and aborts work even when refresh and revocation are delayed', async t => {
  const delayed = deferred();
  const deletion = deferred();
  const f = fixture(t, { 'DELETE /api/session': () => deletion.promise });
  await f.connection.login(rootToken); await settle();
  f.handlers['GET /api/state'] = () => ({ ok: true, status: 200, json: () => delayed.promise });
  const refreshing = f.connection.refresh();
  await settle();
  f.connection.logout();
  assert.equal(f.states.at(-1), null);
  assert.equal(f.accesses.at(-1), null);
  assert.equal(f.statuses.at(-1).phase, 'locked');
  assert.equal(f.calls.filter(call => call.url === '/api/state').at(-1).signal.aborted, true);
  delayed.resolve(snapshot({ revision: 9, agents: [{ name: 'late-private-canary' }] }));
  assert.equal(await refreshing, false);
  await settle();
  assert.equal(f.states.at(-1), null);
  assert.equal(f.states.some(value => JSON.stringify(value).includes('late-private-canary')), false);
  assert.equal(f.timers.size, 0);
  deletion.resolve(json({ ok: true }));
});

test('a session minted after logout is revoked without reading or becoming visible', async t => {
  const pendingLogin = deferred();
  const f = fixture(t, { 'POST /api/session': () => pendingLogin.promise });
  const loggingIn = f.connection.login(rootToken);
  f.connection.logout();
  pendingLogin.resolve(json(sessionBody()));
  assert.equal(await loggingIn, null);
  await settle();
  assert.equal(f.accesses.every(value => value === null), true);
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.url}`), ['POST /api/session', 'DELETE /api/session']);
  assert.equal(f.calls[1].headers.Authorization, `Bearer ${sessionToken}`);
});

test('new login cannot be overwritten by an older login or delayed action response', async t => {
  const firstLogin = deferred();
  const f = fixture(t, { 'POST /api/session': () => firstLogin.promise });
  const old = f.connection.login('synthetic-old-root');
  f.handlers['POST /api/session'] = () => json(sessionBody({ sessionToken: 'synthetic-new-session' }));
  const active = await f.connection.login('synthetic-new-root'); await settle();
  firstLogin.resolve(json(sessionBody({ domain: { ...domain, id: 'old-domain' } })));
  assert.equal(await old, null); await settle();
  assert.deepEqual(f.accesses.at(-1), active);
  const lateAction = deferred();
  f.handlers['POST /api/actions'] = () => ({ ok: true, status: 200, json: () => lateAction.promise });
  const acting = f.connection.action({ type: 'attention.resolve' }); await settle();
  f.connection.logout();
  lateAction.resolve({ ok: true });
  assert.equal(await acting, false);
  assert.equal(f.states.at(-1), null);
});

test('a replaced domain cannot receive delayed snapshot data from the previous session', async t => {
  const delayed = deferred();
  const f = fixture(t, { 'GET /api/state': () => ({ ok: true, status: 200, json: () => delayed.promise }) });
  await f.connection.login(rootToken); await settle();
  const nextDomain = { id: 'synthetic-company', environmentId: 'synthetic-vm' };
  const secondStream = eventStream();
  f.handlers['POST /api/session'] = () => json(sessionBody({ domain: nextDomain, sessionToken: 'synthetic-next-session' }));
  f.handlers['GET /api/state'] = () => json(snapshot({ domain: nextDomain, revision: 2 }));
  f.handlers['GET /api/stream'] = () => secondStream.response;
  await f.connection.login('synthetic-next-root'); await settle();
  delayed.resolve(snapshot({ agents: [{ name: 'previous-domain-canary' }] })); await settle();
  assert.equal(f.states.at(-1).domain.id, nextDomain.id);
  assert.equal(f.states.some(value => JSON.stringify(value).includes('previous-domain-canary')), false);
  assert.equal(f.stream.cancelled, true);
});

for (const status of [401, 403]) {
  test(`stream reconnect uses the same authority; ${status} revocation clears data and stops retries`, async t => {
    const f = fixture(t);
    await f.connection.login(rootToken); await settle();
    f.stream.close(); await settle();
    assert.equal(f.states.at(-1).revision, 1);
    assert.equal(f.statuses.at(-1).phase, 'reconnecting');
    assert.equal(f.timers.size, 1);
    f.handlers['GET /api/stream'] = () => json({}, status);
    await f.retry();
    assert.equal(f.states.at(-1), null);
    assert.equal(f.accesses.at(-1), null);
    assert.equal(f.statuses.at(-1).phase, 'locked');
    assert.equal(f.timers.size, 0);
    assert.equal(f.calls.filter(call => call.url === '/api/stream').every(call => call.headers.Authorization === `Bearer ${sessionToken}`), true);
  });
}

for (const change of [{ instanceId: 'launch-b' }, { domain: { ...domain, id: 'other' } }, { domain: { ...domain, environmentId: 'other' } }]) {
  test(`changed authority ${JSON.stringify(change)} clears data before delivering the snapshot`, async t => {
    const f = fixture(t);
    await f.connection.login(rootToken); await settle();
    f.stream.state(snapshot({ ...change, agents: [{ name: 'foreign-authority-canary' }] })); await settle();
    assert.equal(f.states.at(-1), null);
    assert.equal(f.states.some(value => JSON.stringify(value).includes('foreign-authority-canary')), false);
    assert.equal(f.statuses.at(-1).phase, 'locked');
    assert.equal(f.stream.cancelled, true);
    assert.equal(f.timers.size, 0);
  });
}

test('SSE handles fragmented UTF-8, CRLF, comments and multiline data without advancing on empty events', async t => {
  const f = fixture(t);
  await f.connection.login(rootToken); await settle();
  const before = f.states.length;
  f.stream.send(': keepalive\r\n\r\nevent: state\r\n\r\nevent: other\r\ndata: ignored\r\n\r\n');
  await settle(); assert.equal(f.states.length, before);
  const next = snapshot({ revision: 2, agents: [{ name: 'Synthetic 工具' }] });
  const text = `event: state\r\n${JSON.stringify(next, null, 2).split('\n').map(line => `data: ${line}\r\n`).join('')}\r\n`;
  const bytes = new TextEncoder().encode(text);
  for (let index = 0; index < bytes.length; index += 7) f.stream.send(bytes.slice(index, index + 7));
  await settle();
  assert.deepEqual(f.states.at(-1), next);
  f.stream.state(snapshot({ revision: 1 })); await settle();
  assert.equal(f.states.at(-1).revision, 2);
});

test('malformed JSON reconnects within the existing authority and keeps only its last valid snapshot', async t => {
  const f = fixture(t);
  await f.connection.login(rootToken); await settle();
  f.stream.send('event: state\ndata: {bad json}\n\n'); await settle();
  assert.equal(f.states.at(-1).revision, 1);
  assert.equal(f.statuses.at(-1).phase, 'reconnecting');
  assert.match(f.statuses.at(-1).message, /unreadable/);
  assert.equal(f.stream.cancelled, true);
  const second = eventStream();
  f.handlers['GET /api/stream'] = () => second.response;
  await f.retry();
  second.state(snapshot({ revision: 3 })); await settle();
  assert.equal(f.states.at(-1).revision, 3);
  assert.equal(f.calls.filter(call => call.url === '/api/stream').every(call => call.headers.Authorization === `Bearer ${sessionToken}`), true);
});

for (const content of ['x'.repeat(121), `event: other\n${'data: 1234567890\n'.repeat(10)}`]) {
  test('SSE frame limit bounds unterminated lines and accumulated data, without silently truncating', async t => {
    const f = fixture(t, {}, { maxEventChars: 120 });
    await f.connection.login(rootToken); await settle();
    f.stream.send(content); await settle();
    assert.equal(f.states.at(-1).revision, 1);
    assert.match(f.statuses.at(-1).message, /browser stream limit/);
    assert.equal(f.stream.cancelled, true);
  });
}

test('several complete small SSE frames in one chunk do not trip the per-event bound', async t => {
  const f = fixture(t, {}, { maxEventChars: 40 });
  await f.connection.login(rootToken); await settle();
  f.stream.send(': small keepalive\n\n'.repeat(100)); await settle();
  assert.equal(f.statuses.at(-1).phase, 'live');
  assert.equal(f.timers.size, 0);
});

test('reader sessions cannot issue coordination requests', async t => {
  const f = fixture(t, { 'POST /api/session': () => json(sessionBody({ writable: false })) });
  await f.connection.login(rootToken); await settle();
  await assert.rejects(f.connection.action({ type: 'handoff.claim' }), /read-only/);
  assert.equal(f.calls.some(call => call.url === '/api/actions'), false);
  assert.equal(f.states.at(-1).revision, 1);
});

for (const endpoint of ['/api/state', '/api/actions']) {
  test(`${endpoint} authorization failure clears the entire session`, async t => {
    const f = fixture(t);
    await f.connection.login(rootToken); await settle();
    f.handlers[`${endpoint === '/api/state' ? 'GET' : 'POST'} ${endpoint}`] = () => json({}, 401);
    assert.equal(await (endpoint === '/api/state' ? f.connection.refresh() : f.connection.action({})), false);
    assert.equal(f.states.at(-1), null);
    assert.equal(f.accesses.at(-1), null);
    assert.equal(f.stream.cancelled, true);
  });
}

test('invalid session metadata is rejected and the issued session is revoked without starting reads', async t => {
  const f = fixture(t, { 'POST /api/session': () => json(sessionBody({ domain: { id: 'missing-environment' } })) });
  await assert.rejects(f.connection.login(rootToken), /invalid session/); await settle();
  assert.equal(f.calls.some(call => call.method === undefined), false);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.accesses.at(-1), null);
});

test('wrong stream media type reconnects without treating a response body as activity', async t => {
  const f = fixture(t, { 'GET /api/stream': () => json({ error: 'synthetic-response-canary' }) });
  await f.connection.login(rootToken); await settle();
  assert.equal(f.states.at(-1).revision, 1);
  assert.equal(f.statuses.at(-1).phase, 'reconnecting');
  assert.equal(JSON.stringify(f.statuses).includes('synthetic-response-canary'), false);
});

test('actual loopback server exchanges a reader session, streams its domain, and revokes all browser data', { timeout: 5000 }, async t => {
  const app = await createServer({ domain });
  const url = await app.listen(0);
  const received = deferred();
  const revoked = deferred();
  const reads = [];
  const requests = [];
  let connected = false;
  const connection = createConnection({
    fetch: (path, options) => {
      const request = fetch(`${url}${path}`, options);
      requests.push(request);
      return request;
    },
    onState: value => { reads.push(value); if (value?.agents.length) received.resolve(value); },
    onAccess: value => { if (value) connected = true; else if (connected) revoked.resolve(); },
    retryMs: 1,
  });
  t.after(async () => {
    connection.logout();
    await settle();
    await Promise.allSettled(requests);
    await app.close();
  });
  const key = Object.keys(app.tokens.ingest)[0];
  await app.dispatchSource(key, [{ type: 'agent.upsert', data: {
    id: 'synthetic-worker', name: 'Synthetic private canary', provider: 'Custom', project: 'Synthetic project', status: 'idle',
  } }]);
  const access = await connection.login(app.tokens.read);
  assert.equal(access.writable, false);
  const data = await received.promise;
  assert.deepEqual(data.domain, domain);
  assert.equal(data.instanceId, access.instanceId);
  assert.equal(data.agents[0].name, 'Synthetic private canary');
  await assert.rejects(connection.action({ type: 'attention.resolve', data: { id: 'missing' } }), /read-only/);
  app.revokeToken(app.tokens.read);
  await revoked.promise;
  assert.equal(reads.at(-1), null);
  assert.equal(await connection.refresh(), false);
});
