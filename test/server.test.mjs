import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { createServer, loadState } from '../server.mjs';

async function fixture(t, options = {}) {
  const app = await createServer(options);
  const url = await app.listen(0);
  t.after(() => app.close());
  const send = (body, headers = {}) => fetch(`${url}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.tokens.ingest['api:1']}`, ...headers }, body: JSON.stringify(body) });
  const act = body => fetch(`${url}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.tokens.action}` }, body: JSON.stringify(body) });
  const read = path => fetch(url + path, { headers: { authorization: `Bearer ${app.tokens.read}` } });
  return { app, url, send, act, read };
}
const agent = { type: 'agent.upsert', data: { id: 'a', name: 'Builder', project: 'Harbor', provider: 'Custom', status: 'working' } };

test('local API authenticates capabilities and rejects foreign origins and hosts', async t => {
  const { app, url, send, read } = await fixture(t);
  assert.equal((await send(agent, { authorization: '' })).status, 401);
  assert.equal((await send(agent, { origin: 'https://untrusted.example' })).status, 403);
  const foreignHost = await new Promise((resolveResponse, reject) => {
    const req = request(`${url}/api/state`, { headers: { host: 'untrusted.example' } }, response => { response.resume(); resolveResponse(response.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await send(agent, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send(agent, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(agent)).status, 200);
  const state = await (await read('/api/state')).json();
  assert.equal(state.agents.length, 1);
  for (const secret of [app.tokens.read, app.tokens.action, ...Object.values(app.tokens.ingest)]) assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal((await fetch(`${url}/api/session`)).status, 401);
  assert.equal((await (await read('/api/session')).json()).writable, false);
  assert.equal((await (await fetch(`${url}/api/session`, { headers: { authorization: `Bearer ${app.tokens.action}` } })).json()).writable, true);
  assert.equal((await fetch(`${url}/api/token`)).status, 404);
});

test('concurrent claims have exactly one winner and a durable domain result', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-test-'));
  const dataFile = join(folder, 'state.json');
  const { app, send, act } = await fixture(t, { dataFile });
  t.after(async () => { await app.close(); await rm(folder, { recursive: true, force: true }); });
  assert.equal((await send([agent, { type: 'handoff.offer', data: { id: 'offer', agentId: 'a', title: 'Review changes', detail: 'Check migration behavior.' } }])).status, 200);
  const id = app.snapshot().handoffs[0].id;
  const replies = await Promise.all(['reviewer-one', 'reviewer-two'].map(owner => act({ type: 'handoff.claim', data: { id, owner } })));
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  const saved = await loadState(dataFile);
  assert.deepEqual(saved.state, Object.fromEntries(Object.entries(app.snapshot()).filter(([k]) => !['domain', 'sources', 'provenance', 'mode', 'instanceId', 'serverTime'].includes(k))));
  const before = await readFile(dataFile, 'utf8');
  assert.equal((await send([agent, { type: 'unknown.operation', data: {} }])).status, 400);
  assert.equal(await readFile(dataFile, 'utf8'), before);
});

test('a failed durable replacement leaves the in-memory snapshot unchanged', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-test-'));
  const dataFile = join(folder, 'state.json');
  const { app, send } = await fixture(t, { dataFile });
  t.after(async () => { await app.close(); await rm(folder, { recursive: true, force: true }); });
  await rm(dataFile);
  await mkdir(dataFile);
  assert.equal((await send(agent)).status, 500);
  assert.equal(app.snapshot().agents.length, 0);
  assert.equal(app.snapshot().revision, 0);
});

test('corrupt state is reported and preserved, never silently reset', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'state.json');
  await writeFile(file, '{not JSON');
  await assert.rejects(loadState(file), /original file preserved/);
  assert.equal(await readFile(file, 'utf8'), '{not JSON');
});

test('authenticated SSE sends the initial state and a subsequent committed change', async t => {
  const { read, send } = await fixture(t);
  const response = await read('/api/stream');
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/);
  assert.match(first, /"revision":0/);
  await send(agent);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"revision":1/);
  await reader.cancel();
});

test('dashboard cannot ingest spans and request size and static files are bounded', async t => {
  const { url, send, act } = await fixture(t);
  assert.equal((await act(agent)).status, 400);
  assert.equal((await send({ type: 'agent.upsert', data: { id: 'a', name: 'x'.repeat(1_048_576) } })).status, 413);
  const staticResponse = await fetch(`${url}/package.json`);
  assert.equal(staticResponse.status, 404);
  assert.match(staticResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
