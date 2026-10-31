import test from 'node:test';
import assert from 'node:assert/strict';
import * as domain from '../lib/domain.mjs';
import { applyCommands, emptyState } from '../lib/model.mjs';

const NOW = '2026-01-15T12:00:00.000Z';
const DOMAIN = { id: 'personal', environmentId: 'workstation' };
const SOURCE = { id: 'session', provider: 'codex', toolInstanceId: 'terminal', generation: 1 };
const command = (type, data) => ({ type, data });
const invalid = error => error.statusCode === 400;

test('enrollment normalization preserves explicit identity evidence and rejects ambiguous metadata', () => {
  assert.deepEqual(domain.normalizeDomain(DOMAIN), DOMAIN);
  const source = domain.normalizeSource(SOURCE);
  assert.deepEqual(source.identity, { alias: null, evidence: 'unknown' });
  assert.equal(source.path, null);
  assert.equal(source.fileIdentity, null);
  assert.equal(domain.sourceKey(source), 'session:1');
  assert.deepEqual(domain.normalizeSource({ ...SOURCE, identity: 'account-a' }).identity,
    { alias: 'account-a', evidence: 'operator-asserted' });
  assert.deepEqual(domain.normalizeSource(source), source);
  for (const value of [null, { ...DOMAIN, id: '../company' }, { ...DOMAIN, extra: true }, { ...DOMAIN, environmentId: 'A B' }]) {
    assert.throws(() => domain.normalizeDomain(value), invalid);
  }
  for (const value of [{ ...SOURCE, generation: 0 }, { ...SOURCE, generation: '1' }, { ...SOURCE, token: 'synthetic' },
    { ...SOURCE, identity: { alias: 'account-a', evidence: 'verified' } },
    { ...SOURCE, identity: { alias: 'account-a', evidence: 'unknown' } },
    { ...SOURCE, fileIdentity: { realpath: '/fixtures/session.jsonl', dev: 1, ino: '2' } }]) {
    assert.throws(() => domain.normalizeSource(value), invalid);
  }
});

test('ingestion namespaces every record and reference without truncation collisions or input mutation', () => {
  const commands = [command('agent.upsert', { id: 'a', provider: 'forged' }),
    command('span.upsert', { id: 's', agentId: 'a', laneId: 'main' }),
    command('run.upsert', { id: 'r', agentId: 'a' }),
    command('handoff.offer', { id: 'h', agentId: 'a', title: 'Synthetic review' }),
    command('attention.open', { id: 'n', agentId: 'a', title: 'Synthetic question' })];
  const before = structuredClone(commands);
  const scoped = domain.scopeCommands(DOMAIN, SOURCE, commands);
  const state = applyCommands(emptyState(), scoped, NOW);
  assert.deepEqual(commands, before);
  assert.equal(state.agents[0].provider, 'codex');
  assert.equal(state.agents[0].id, domain.namespaceId(DOMAIN, SOURCE, 'a'));
  assert.equal(state.events[0].laneId, 'main');
  for (const name of ['events', 'runs', 'handoffs', 'attention']) assert.equal(state[name][0].agentId, state.agents[0].id);
  assert.match(domain.sourcePrefix(DOMAIN, SOURCE), /^[a-zA-Z0-9_]+$/);
  for (const other of [{ ...SOURCE, id: 'other' }, { ...SOURCE, generation: 2 }]) {
    assert.notEqual(domain.namespaceId(DOMAIN, other, 'a'), state.agents[0].id);
  }
  assert.notEqual(domain.namespaceId({ ...DOMAIN, environmentId: 'remote' }, SOURCE, 'a'), state.agents[0].id);
  assert.notEqual(domain.namespaceId({ ...DOMAIN, id: 'work' }, SOURCE, 'a'), state.agents[0].id);
  assert.notEqual(domain.namespaceId(DOMAIN, SOURCE, `${'x'.repeat(159)}a`), domain.namespaceId(DOMAIN, SOURCE, `${'x'.repeat(159)}b`));
  const partial = domain.scopeCommands(DOMAIN, SOURCE, command('span.upsert', { id: 's', detail: 'Updated' }));
  assert.equal(Object.hasOwn(partial[0].data, 'agentId'), false);
  assert.equal(Object.hasOwn(partial[0].data, 'laneId'), false);
  const updated = applyCommands(state, partial, NOW);
  assert.equal(updated.events[0].laneId, state.events[0].laneId);
  for (const forged of [command('handoff.claim', { id: 'h', owner: 'attacker' }),
    command('agent.upsert', { id: 'a', domainId: 'work' }),
    command('handoff.offer', { id: 'h', agentId: 'a', title: 'No', owner: 'attacker' }),
    command('attention.open', { id: 'n', agentId: 'a', resolvedAt: NOW })]) {
    assert.throws(() => domain.scopeCommands(DOMAIN, SOURCE, forged), invalid);
  }
});

test('domain stores retain historical generations while rejecting enrollment rebinding and foreign records', () => {
  const bound = { ...SOURCE, identity: 'account-a', path: '/fixtures/session.jsonl',
    fileIdentity: { realpath: '/fixtures/session.jsonl', dev: '1', ino: '2' } };
  const store = domain.createStore(DOMAIN, [bound]);
  store.state = applyCommands(store.state, domain.scopeCommands(DOMAIN, bound, [
    command('agent.upsert', { id: 'a' }), command('span.upsert', { id: 's', agentId: 'a' }),
  ]), NOW);
  const clean = domain.validateStore(store, DOMAIN, [bound]);
  assert.equal(clean.version, 2);
  assert.equal(clean.state.events[0].laneId, 'main');
  const childUpdate = domain.scopeCommands(DOMAIN, bound, command('span.upsert', { id: 's', laneId: 'child' }));
  clean.state = applyCommands(clean.state, childUpdate, NOW);
  clean.state = applyCommands(clean.state, domain.scopeCommands(DOMAIN, bound, command('span.upsert', { id: 's', agentId: 'a', detail: 'Partial' })), NOW);
  assert.equal(domain.validateStore(clean).state.events[0].laneId, 'child');
  const before = structuredClone(clean);
  const next = { ...bound, generation: 2, identity: 'account-b' };
  const reconciled = domain.reconcileSources(clean, [next]);
  assert.equal(reconciled.sources.length, 2);
  assert.deepEqual(reconciled.state, clean.state);
  assert.deepEqual(domain.reconcileSources(clean, []).sources, clean.sources);
  for (const changed of [{ ...bound, identity: 'account-b' }, { ...bound, provider: 'custom' },
    { ...bound, fileIdentity: { ...bound.fileIdentity, ino: '3' } }, { ...bound, path: '/fixtures/other.jsonl' }]) {
    assert.throws(() => domain.reconcileSources(clean, [changed]), invalid);
  }
  assert.throws(() => domain.validateStore(clean, { ...DOMAIN, id: 'company' }), invalid);
  assert.throws(() => domain.validateStore(clean, { ...DOMAIN, environmentId: 'remote' }), invalid);
  assert.throws(() => domain.validateStore(emptyState()), /legacy|version/i);
  assert.throws(() => domain.createStore(DOMAIN, [bound, bound]), invalid);
  const other = { ...SOURCE, id: 'other' };
  const two = domain.reconcileSources(clean, [other]);
  two.state = applyCommands(two.state, domain.scopeCommands(DOMAIN, other, command('agent.upsert', { id: 'a' })), NOW);
  const foreignRef = structuredClone(two);
  foreignRef.state.events[0].agentId = domain.namespaceId(DOMAIN, other, 'a');
  assert.throws(() => domain.validateStore(foreignRef), invalid);
  const unscoped = structuredClone(two);
  unscoped.state.agents[1].id = 'unscoped';
  assert.throws(() => domain.validateStore(unscoped), invalid);
  assert.deepEqual(clean, before);
});

test('purging a source tombstones every generation and prevents stale records or enrollment from returning', () => {
  const sources = [SOURCE, { ...SOURCE, generation: 2 }, { ...SOURCE, id: 'retained' }];
  const store = domain.createStore(DOMAIN, sources);
  for (const source of sources) {
    store.state = applyCommands(store.state, domain.scopeCommands(DOMAIN, source, [
      command('agent.upsert', { id: 'a' }), command('span.upsert', { id: 's', agentId: 'a' }),
      command('handoff.offer', { id: 'h', agentId: 'a', title: 'Synthetic review' }),
      command('attention.open', { id: 'n', agentId: 'a', title: 'Synthetic question' }),
      command('run.upsert', { id: 'r', agentId: 'a' }),
    ]), NOW);
  }
  const before = structuredClone(store);
  const purged = domain.purgeSource(store, 'session');
  assert.deepEqual(purged.revokedSources, ['session:1', 'session:2']);
  assert.equal(purged.sources.length, 3);
  assert.equal(purged.state.revision, store.state.revision + 1);
  for (const collection of ['agents', 'events', 'runs', 'handoffs', 'attention']) assert.equal(purged.state[collection].length, 1);
  assert.deepEqual(domain.validateStore(purged), purged);
  for (const source of sources.slice(0, 2)) assert.throws(() => domain.reconcileSources(purged, [source]), invalid);
  const stale = structuredClone(purged);
  stale.state = applyCommands(stale.state, domain.scopeCommands(DOMAIN, SOURCE, command('agent.upsert', { id: 'a' })), NOW);
  assert.throws(() => domain.validateStore(stale), invalid);
  assert.equal(domain.reconcileSources(purged, [{ ...SOURCE, generation: 3 }]).sources.length, 4);
  assert.throws(() => domain.purgeSource(store, 'missing'), invalid);
  assert.deepEqual(store, before);
});

test('legacy migration requires explicit agent selection and preserves original history and coordination state', () => {
  let legacy = emptyState();
  for (const agentId of ['selected', 'excluded']) {
    legacy = applyCommands(legacy, [command('agent.upsert', { id: agentId, provider: 'Legacy Provider' }),
      command('span.upsert', { id: `${agentId}-span`, agentId, laneId: 'child', detail: 'Synthetic detail' }),
      command('run.upsert', { id: `${agentId}-run`, agentId }),
      command('handoff.offer', { id: `${agentId}-handoff`, agentId, title: 'Synthetic review' }),
      command('attention.open', { id: `${agentId}-attention`, agentId, title: 'Synthetic question' })], NOW);
  }
  legacy = applyCommands(legacy, command('handoff.claim', { id: 'selected-handoff', owner: 'reviewer' }), NOW);
  const before = structuredClone(legacy);
  const migrated = domain.migrateLegacy(legacy, { domain: DOMAIN, source: SOURCE, agentIds: ['selected'] });
  assert.deepEqual(domain.validateStore(migrated, DOMAIN, [SOURCE]), migrated);
  assert.equal(migrated.state.revision, legacy.revision);
  for (const collection of ['agents', 'events', 'runs', 'handoffs', 'attention']) assert.equal(migrated.state[collection].length, 1);
  assert.equal(migrated.state.agents[0].provider, 'Legacy Provider');
  assert.equal(migrated.state.events[0].detail, 'Synthetic detail');
  assert.equal(migrated.state.events[0].laneId, 'child');
  assert.equal(migrated.state.handoffs[0].status, 'claimed');
  assert.equal(migrated.state.handoffs[0].owner, 'reviewer');
  assert.deepEqual(legacy, before);
  for (const agentIds of [undefined, [], ['unknown'], ['selected', 'selected']]) {
    assert.throws(() => domain.migrateLegacy(legacy, { domain: DOMAIN, source: SOURCE, agentIds }), invalid);
  }
});

test('untrusted prototypes, accessors, malformed arrays and oversized inputs fail without executing getters', () => {
  let accessed = false;
  const getter = { ...SOURCE };
  Object.defineProperty(getter, 'identity', { get() { accessed = true; throw new Error('Getter ran'); } });
  for (const source of [getter, Object.create(SOURCE), JSON.parse('{"id":"session","provider":"custom","toolInstanceId":"api","generation":1,"__proto__":{}}'),
    { ...SOURCE, [Symbol('extra')]: true }, { ...SOURCE, identity: 'x'.repeat(129) }, { ...SOURCE, path: 'x'.repeat(4097) },
    { ...SOURCE, fileIdentity: { realpath: '/fixtures/session.jsonl', dev: '1', ino: '01' } }]) {
    assert.throws(() => domain.normalizeSource(source), invalid);
  }
  const arrays = [new Array(1), Object.assign([], { extra: true }), Array(1001).fill(SOURCE)];
  const getterArray = [];
  Object.defineProperty(getterArray, '0', { get() { accessed = true; throw new Error('Getter ran'); } });
  arrays.push(getterArray);
  for (const sources of arrays) assert.throws(() => domain.createStore(DOMAIN, sources), invalid);
  assert.throws(() => domain.namespaceId(DOMAIN, SOURCE, 'x'.repeat(161)), invalid);
  assert.throws(() => domain.scopeCommands(DOMAIN, SOURCE, []), invalid);
  assert.throws(() => domain.scopeCommands(DOMAIN, SOURCE, Array(1001).fill(command('agent.upsert', { id: 'a' }))), invalid);
  assert.throws(() => domain.scopeCommands(DOMAIN, SOURCE, command('agent.upsert', { id: 'a', name: { hidden: true } })), invalid);
  const store = domain.createStore(DOMAIN, [SOURCE]);
  assert.throws(() => domain.validateStore({ ...store, unexpected: true }), invalid);
  assert.throws(() => domain.validateStore({ ...store, revokedSources: ['unknown:1'] }), invalid);
  assert.throws(() => domain.validateStore({ ...store, revokedSources: ['session:1', 'session:1'] }), invalid);
  const poisoned = structuredClone(store);
  Object.defineProperty(poisoned, 'state', { get() { accessed = true; throw new Error('Getter ran'); } });
  assert.throws(() => domain.validateStore(poisoned), invalid);
  store.state.revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => domain.purgeSource(store, SOURCE.id), invalid);
  assert.equal(accessed, false);
  assert.equal({}.polluted, undefined);
});

test('coordination records can be created inside the owning namespace without changing source provenance', () => {
  const store = domain.createStore(DOMAIN, [SOURCE]);
  store.state = applyCommands(store.state, domain.scopeCommands(DOMAIN, SOURCE, command('agent.upsert', { id: 'a' })), NOW);
  const handoffId = domain.namespaceId(DOMAIN, SOURCE, 'operator-offer');
  store.state = applyCommands(store.state, command('handoff.offer', { id: handoffId, agentId: store.state.agents[0].id, title: 'Synthetic review' }), NOW);
  store.state = applyCommands(store.state, command('handoff.claim', { id: handoffId, owner: 'reviewer' }), NOW);
  store.state = applyCommands(store.state, command('handoff.complete', { id: handoffId, owner: 'reviewer' }), NOW);
  const clean = domain.validateStore(store);
  assert.equal(clean.state.handoffs[0].status, 'completed');
  assert.equal(clean.state.handoffs[0].owner, 'reviewer');
  clean.sources[0].identity.alias = 'local mutation';
  assert.equal(store.sources[0].identity.alias, null);
});

test('agent-local lane names remain readable without granting cross-source entity access', () => {
  const other = { ...SOURCE, id: 'other' };
  const store = domain.createStore(DOMAIN, [SOURCE, other]);
  for (const source of [SOURCE, other]) {
    store.state = applyCommands(store.state, domain.scopeCommands(DOMAIN, source, [
      command('agent.upsert', { id: 'a' }),
      command('span.upsert', { id: 'main-span', agentId: 'a' }),
      command('span.upsert', { id: 'child-span', agentId: 'a', laneId: 'schema-check' }),
    ]), NOW);
  }
  let clean = domain.validateStore(store);
  assert.equal(clean.state.agents.length, 2);
  assert.equal(new Set(clean.state.events.map(event => event.id)).size, 4);
  for (const source of [SOURCE, other]) {
    const agentId = domain.namespaceId(DOMAIN, source, 'a');
    const events = clean.state.events.filter(event => event.agentId === agentId);
    assert.deepEqual(events.map(event => event.laneId), ['main', 'schema-check']);
  }
  const foreignAgentId = domain.namespaceId(DOMAIN, other, 'a');
  clean.state = applyCommands(clean.state, domain.scopeCommands(DOMAIN, SOURCE,
    command('span.upsert', { id: 'label-only', agentId: 'a', laneId: foreignAgentId })), NOW);
  clean = domain.validateStore(clean);
  const labelOnly = clean.state.events.find(event => event.id === domain.namespaceId(DOMAIN, SOURCE, 'label-only'));
  assert.equal(labelOnly.laneId, foreignAgentId);
  assert.equal(labelOnly.agentId, domain.namespaceId(DOMAIN, SOURCE, 'a'));
  assert.equal(clean.state.events.filter(event => event.agentId === foreignAgentId).length, 2);
  assert.throws(() => applyCommands(clean.state, domain.scopeCommands(DOMAIN, SOURCE,
    command('span.upsert', { id: 'forged-ref', agentId: foreignAgentId, laneId: 'main' })), NOW), invalid);
});
