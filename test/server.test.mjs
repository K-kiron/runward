import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { createServer, loadState } from '../server.mjs';

const token = 'test-only-write-token-0001';
async function fixture(t, options = {}) {
  const app = await createServer({ token, ...options });
  const url = await app.listen(0);
  t.after(() => app.close());
  const send = (body, headers = {}) => fetch(`${url}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  return { app, url, send };
}
const agent = { type: 'agent.upsert', data: { id: 'a', name: 'Builder', project: 'Harbor', provider: 'Custom', status: 'working' } };

test('local API requires write authentication and rejects foreign origins and hosts', async t => {
  const { url, send } = await fixture(t);
  assert.equal((await send(agent, { authorization: '' })).status, 401);
  assert.equal((await send(agent, { origin: 'https://untrusted.example' })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/state`, { headers: { host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await send(agent, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send(agent, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(agent)).status, 200);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.agents.length, 1);
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.deepEqual(await (await fetch(`${url}/api/session`)).json(), { writable: false });
  assert.deepEqual(await (await fetch(`${url}/api/session`, { headers: { authorization: `Bearer ${token}` } })).json(), { writable: true });
  assert.equal((await fetch(`${url}/api/token`)).status, 404);
});

test('concurrent claims have exactly one winner and a durable result', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const dataFile = join(folder, 'state.json');
  const { app, send } = await fixture(t, { dataFile });
  assert.equal((await send([agent, { type: 'handoff.offer', data: { id: 'offer', agentId: 'a', title: 'Review changes', detail: 'Check migration behavior.' } }])).status, 200);
  const replies = await Promise.all(['reviewer-one', 'reviewer-two'].map(owner => send({ type: 'handoff.claim', data: { id: 'offer', owner } })));
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  const saved = await loadState(dataFile);
  assert.deepEqual(saved, Object.fromEntries(Object.entries(app.snapshot()).filter(([k]) => !['mode', 'instanceId', 'serverTime'].includes(k))));
  const before = await readFile(dataFile, 'utf8');
  assert.equal((await send([agent, { type: 'unknown.operation', data: {} }])).status, 400);
  assert.equal(await readFile(dataFile, 'utf8'), before);
});

test('unwritable persistence leaves the in-memory snapshot unchanged', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const { emptyState } = await import('../lib/model.mjs');
  const { app, send } = await fixture(t, { state: emptyState(), dataFile: folder });
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

test('SSE sends the initial state and a subsequent committed change', async t => {
  const { url, send } = await fixture(t);
  const abort = new AbortController();
  const response = await fetch(`${url}/api/stream`, { signal: abort.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/);
  assert.match(first, /"revision":0/);
  await send(agent);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"revision":1/);
  abort.abort();
  await reader.cancel().catch(() => {});
});

test('dashboard route cannot ingest spans and request size is bounded', async t => {
  const { url, send } = await fixture(t);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const blocked = await fetch(`${url}/api/actions`, { method: 'POST', headers, body: JSON.stringify(agent) });
  assert.equal(blocked.status, 400);
  assert.equal((await send({ type: 'agent.upsert', data: { id: 'a', name: 'x'.repeat(1_048_576) } })).status, 413);
  const staticResponse = await fetch(`${url}/package.json`);
  assert.equal(staticResponse.status, 404);
  assert.match(staticResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
