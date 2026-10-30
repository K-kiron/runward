import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { emptyState } from '../lib/model.mjs';

const domain = { id: 'personal', environmentId: 'synthetic-laptop' };
const sources = ['one', 'two'].map(id => ({ id, provider: 'custom', toolInstanceId: id, generation: 1 }));
const agent = { type: 'agent.upsert', data: { id: 'same-id', name: 'Synthetic agent', project: 'Same project' } };
async function fixture(t, options = {}) {
  const app = await createServer({ domain, sources, ...options });
  t.after(() => app.close());
  return { app, url: await app.listen(0) };
}
const headers = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test('uncredentialed reads expose neither data nor domain identity', async t => {
  const { url } = await fixture(t);
  for (const path of ['/api/state', '/api/stream', '/api/session']) {
    const response = await fetch(url + path);
    await response.body.cancel();
    assert.equal(response.status, 401, path);
  }
  assert.equal((await fetch(url + '/api/health')).status, 200);
});

test('action credentials cannot be used to ingest source data', async t => {
  const { app, url } = await fixture(t);
  const response = await fetch(url + '/api/events', {
    method: 'POST', headers: headers(app.tokens?.action ?? app.token), body: JSON.stringify(agent),
  });
  assert.equal(response.status, 403);
});

test('read credentials cannot mutate coordination or ingest history', async t => {
  const { app, url } = await fixture(t);
  for (const path of ['/api/actions', '/api/events']) {
    const response = await fetch(url + path, { method: 'POST', headers: headers(app.tokens?.read ?? app.token), body: JSON.stringify(agent) });
    assert.equal(response.status, 403, path);
  }
});

test('browser sessions exchange, read, then revoke access without retaining a stream', async t => {
  const { app, url } = await fixture(t);
  const login = await fetch(url + '/api/session', { method: 'POST', headers: headers(app.tokens?.read ?? app.token) });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.writable, false);
  assert.deepEqual(session.domain, domain);
  assert.ok(session.sessionToken);
  const access = headers(session.sessionToken);
  const stream = await fetch(url + '/api/stream', { headers: access });
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: state/);
  assert.equal((await fetch(url + '/api/session', { method: 'DELETE', headers: access })).status, 200);
  assert.equal((await reader.read()).done, true);
  assert.equal((await fetch(url + '/api/state', { headers: access })).status, 401);
  assert.equal((await fetch(url + '/api/stream', { headers: access })).status, 401);
});

test('personal and company instances cannot use one another\'s capabilities or state', async t => {
  const a = await fixture(t);
  const company = { id: 'company', environmentId: 'synthetic-vm' };
  const b = await fixture(t, { domain: company });
  await a.app.dispatchSource('one:1', agent);
  await b.app.dispatchSource('one:1', { ...agent, data: { ...agent.data, name: 'Synthetic company canary' } });
  for (const secret of [a.app.tokens.read, a.app.tokens.action, a.app.tokens.ingest['one:1']]) {
    for (const path of ['/api/state', '/api/stream', '/api/session']) {
      const response = await fetch(b.url + path, { headers: headers(secret) });
      await response.body.cancel();
      assert.equal(response.status, 401, path);
    }
  }
  const personal = await (await fetch(a.url + '/api/state', { headers: headers(a.app.tokens.read) })).json();
  assert.equal(JSON.stringify(personal).includes('company canary'), false);
  await assert.rejects(createServer({ domain: company, tokens: { read: a.app.tokens.read } }), /issued for this domain/);
});

test('source capabilities namespace identical producer IDs and reject forged ownership and foreign references', async t => {
  const { app, url } = await fixture(t);
  const ingest = (key, body) => fetch(url + '/api/events', { method: 'POST', headers: headers(app.tokens.ingest[key]), body: JSON.stringify(body) });
  assert.equal((await ingest('one:1', agent)).status, 200);
  assert.equal((await ingest('two:1', { ...agent, data: { ...agent.data, name: 'Second source' } })).status, 200);
  const before = app.snapshot();
  assert.equal(before.agents.length, 2);
  assert.notEqual(before.agents[0].id, before.agents[1].id);
  const foreign = { type: 'span.upsert', data: { id: 'span', agentId: before.agents[1].id, label: 'Foreign reference' } };
  assert.equal((await ingest('one:1', foreign)).status, 400);
  assert.equal((await ingest('one:1', { ...agent, domainId: 'company' })).status, 400);
  assert.equal((await ingest('one:1', { ...agent, data: { ...agent.data, sourceId: 'two' } })).status, 400);
  assert.equal(app.snapshot().revision, before.revision);
});

test('revoking a root closes its child stream without revoking an independent reader', async t => {
  const { app, url } = await fixture(t);
  const session = await (await fetch(url + '/api/session', { method: 'POST', headers: headers(app.tokens.action) })).json();
  const response = await fetch(url + '/api/stream', { headers: headers(session.sessionToken) });
  const reader = response.body.getReader();
  await reader.read();
  app.revokeToken(app.tokens.action);
  assert.equal((await reader.read()).done, true);
  assert.equal((await fetch(url + '/api/state', { headers: headers(session.sessionToken) })).status, 401);
  assert.equal((await fetch(url + '/api/state', { headers: headers(app.tokens.read) })).status, 200);
});

test('session expiry terminates an open stream and denies subsequent reads', async t => {
  const { app, url } = await fixture(t, { sessionTTL: 500 });
  const session = await (await fetch(url + '/api/session', { method: 'POST', headers: headers(app.tokens.read) })).json();
  const response = await fetch(url + '/api/stream', { headers: headers(session.sessionToken) });
  const reader = response.body.getReader();
  await reader.read();
  assert.equal((await reader.read()).done, true);
  assert.equal((await fetch(url + '/api/state', { headers: headers(session.sessionToken) })).status, 401);
});

test('a purged source cannot return through queued callbacks or its old ingest credential', async t => {
  const { app, url } = await fixture(t);
  await app.dispatchSource('one:1', agent);
  await app.dispatchSource('two:1', agent);
  const ingestToken = app.tokens.ingest['one:1'];
  const purge = fetch(url + '/api/sources/one/purge', { method: 'POST', headers: headers(app.tokens.action) });
  assert.equal((await purge).status, 200);
  await assert.rejects(app.dispatchSource('one:1', agent), error => error.code === 'SOURCE_REVOKED');
  assert.equal((await fetch(url + '/api/events', { method: 'POST', headers: headers(ingestToken), body: JSON.stringify(agent) })).status, 401);
  assert.equal(app.snapshot().agents.length, 1);
  assert.equal(app.snapshot().sources.find(source => source.id === 'one').revoked, true);
  const forged = await fetch(url + '/api/sources/two/purge', { method: 'POST', headers: headers(app.tokens.read) });
  assert.equal(forged.status, 403);
});

test('a domain state is locked exclusively and cannot be loaded under another domain', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-isolation-'));
  const dataFile = join(folder, 'state.json');
  const a = await fixture(t, { dataFile });
  t.after(async () => { await a.app.close(); await rm(folder, { recursive: true, force: true }); });
  await a.app.dispatchSource('one:1', agent);
  const before = await readFile(dataFile, 'utf8');
  await assert.rejects(createServer({ domain, sources, dataFile }), /locked/);
  await a.app.close();
  await assert.rejects(createServer({ domain: { ...domain, id: 'company' }, sources, dataFile }), /domain|environment/i);
  assert.equal(await readFile(dataFile, 'utf8'), before);
  const reopened = await createServer({ domain, sources, dataFile });
  assert.equal(reopened.snapshot().agents.length, 1);
  await reopened.close();
});

test('source writes queued behind a purge cannot restore the removed history', async t => {
  const { app } = await fixture(t);
  await app.dispatchSource('one:1', agent);
  const purging = app.purgeSource('one');
  const lateWrite = app.dispatchSource('one:1', agent);
  const rejection = assert.rejects(lateWrite, error => error.code === 'SOURCE_REVOKED');
  await purging;
  await rejection;
  assert.equal(app.snapshot().agents.length, 0);
});

test('legacy snapshots are quarantined without modification or a leaked state lock', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-legacy-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const dataFile = join(folder, 'state.json');
  const original = JSON.stringify(emptyState());
  await writeFile(dataFile, original);
  await assert.rejects(createServer({ domain, sources, dataFile }), /legacy|migration|migrate/i);
  assert.equal(await readFile(dataFile, 'utf8'), original);
  await assert.rejects(readFile(dataFile + '.lock'), { code: 'ENOENT' });
});

test('snapshot callers cannot change live data or enrollment evidence', async t => {
  const { app } = await fixture(t);
  await app.dispatchSource('one:1', agent);
  const copy = app.snapshot();
  copy.agents[0].name = 'Forged mutable data';
  copy.sources[0].identity.alias = 'Forged identity';
  copy.sources[0].identity.evidence = 'operator-asserted';
  const provenance = copy.provenance[copy.agents[0].id];
  assert.equal(provenance.sourceId, 'one');
  assert.equal(provenance.toolInstanceId, 'one');
  assert.equal(provenance.generation, 1);
  provenance.identity.evidence = 'operator-asserted';
  assert.equal(app.snapshot().agents[0].name, 'Synthetic agent');
  assert.equal(app.snapshot().sources[0].identity.evidence, 'unknown');
  assert.equal(app.snapshot().provenance[copy.agents[0].id].identity.evidence, 'unknown');
});

test('closed services reject late source callbacks and purges', async t => {
  const { app } = await fixture(t);
  await app.close();
  await assert.rejects(app.dispatchSource('one:1', agent), /closed|closing/i);
  await assert.rejects(app.purgeSource('one'), /closed|closing/i);
  assert.equal(app.snapshot().revision, 0);
});
