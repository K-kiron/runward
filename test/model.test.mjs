import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands, emptyState, validateSnapshot } from '../lib/model.mjs';
import { demoState } from '../lib/demo.mjs';

const NOW = '2026-01-15T12:00:00.000Z';
const LATER = '2026-01-15T12:01:00.000Z';
const EARLIER = '2026-01-15T11:59:00.000Z';
const command = (type, data) => ({ type, data });
const seeded = () => applyCommands(emptyState(), command('agent.upsert', { id: 'a', name: 'Agent' }), NOW);
const status = code => error => error.statusCode === code;
const offered = () => applyCommands(seeded(), command('handoff.offer', { id: 'h', agentId: 'a', title: 'Review' }), NOW);

test('empty states are independent and partial upserts preserve metadata and unknown metrics', () => {
  const first = emptyState();
  first.agents.push('local');
  assert.equal(emptyState().agents.length, 0);
  const original = seeded();
  const state = applyCommands(original, command('agent.upsert', { id: 'a', name: 'Renamed', lastSeen: LATER }), LATER);
  assert.equal(state.agents[0].startedAt, NOW);
  assert.equal(state.agents[0].lastSeen, LATER);
  assert.equal(state.agents[0].status, 'unknown');
  assert.equal(state.agents[0].contextUsed, null);
  assert.equal(state.agents[0].contextLimit, null);
  assert.equal(original.agents[0].name, 'Agent');
  assert.equal(state.revision, original.revision + 1);
});

test('a batch increments once and rolls back fully on an invalid final command', () => {
  const original = seeded();
  const before = structuredClone(original);
  const commands = [command('agent.upsert', { id: 'b' }), command('span.upsert', { id: 's', agentId: 'missing' })];
  assert.throws(() => applyCommands(original, commands, NOW), status(400));
  assert.deepEqual(original, before);
  commands[1].data.agentId = 'b';
  const state = applyCommands(original, commands, NOW);
  assert.equal(state.revision, 2);
  assert.equal(state.events[0].agentId, 'b');
  state.agents[0].name = 'Local copy';
  assert.equal(original.agents[0].name, 'Agent');
});

test('unrecognized fields, prototype keys, inherited objects, getters and malformed commands are rejected', () => {
  const malicious = JSON.parse('{"id":"a","__proto__":{"polluted":true}}');
  const getter = { id: 'a' };
  Object.defineProperty(getter, 'name', { get() { throw new Error('must not execute'); } });
  const symbol = { id: 'a', [Symbol('hidden')]: true };
  for (const data of [malicious, { id: 'a', constructor: 'bad' }, { id: 'a', extra: true }, Object.create({ id: 'a' }), getter, symbol, { id: 'a', name: '\0bad' }]) {
    assert.throws(() => applyCommands(seeded(), command('agent.upsert', data), NOW), status(400));
  }
  for (const value of [null, {}, [], command('constructor', {}), command('agent.upsert', null), { type: {}, data: {} }, { type: 'agent.upsert', data: { id: 'a' }, ignored: true }]) {
    assert.throws(() => applyCommands(seeded(), value, NOW), status(400));
  }
  assert.equal({}.polluted, undefined);
});

test('UTC dates are canonicalized and invalid dates or reversed intervals are rejected', () => {
  const state = applyCommands(emptyState(), command('agent.upsert', { id: 'a' }), '2026-01-15T12:00:00Z');
  assert.equal(state.agents[0].startedAt, NOW);
  for (const date of ['2026-02-30T12:00:00Z', '2026-01-15', '2026-01-15T12:00:00+00:00', '2026-01-15T24:00:00Z', 'invalid']) {
    assert.throws(() => applyCommands(emptyState(), command('agent.upsert', { id: 'a' }), date), status(400));
  }
  assert.throws(() => applyCommands(state, command('agent.upsert', { id: 'a', lastSeen: EARLIER }), NOW), status(400));
  assert.throws(() => applyCommands(state, command('span.upsert', { id: 's', agentId: 'a', startedAt: NOW, endedAt: EARLIER }), NOW), status(400));
});

test('span updates preserve start and lane metadata, gaps and open end times', () => {
  const state = applyCommands(seeded(), [
    command('span.upsert', { id: 'one', agentId: 'a', startedAt: EARLIER, endedAt: EARLIER, laneId: 'child', kind: 'tool' }),
    command('span.upsert', { id: 'two', agentId: 'a', startedAt: NOW, kind: 'thinking' }),
  ], NOW);
  const updated = applyCommands(state, command('span.upsert', { id: 'two', endedAt: LATER }), LATER);
  assert.equal(state.events[1].endedAt, null);
  assert.equal(updated.events[1].startedAt, NOW);
  assert.equal(updated.events[0].laneId, 'child');
  assert.equal(updated.events[0].endedAt, EARLIER);
});

test('run lifecycle and nullable finite metrics stay truthful', () => {
  const state = applyCommands(seeded(), command('run.upsert', { id: 'r', agentId: 'a' }), NOW);
  assert.equal(state.runs[0].checksPassed, null);
  assert.equal(state.runs[0].cost, null);
  const done = applyCommands(state, command('run.upsert', { id: 'r', status: 'passed', endedAt: LATER, checksPassed: 0, checksTotal: 0, cost: 0 }), LATER);
  assert.equal(done.runs[0].cost, 0);
  assert.equal(done.runs[0].startedAt, NOW);
  for (const fields of [
    { cost: NaN }, { cost: Infinity }, { cost: -1 }, { checksPassed: 0.5 }, { checksTotal: -1 },
    { checksPassed: 2, checksTotal: 1 }, { status: 'passed' }, { endedAt: LATER },
  ]) assert.throws(() => applyCommands(state, command('run.upsert', { id: 'r', ...fields }), NOW), status(400));
  assert.throws(() => applyCommands(seeded(), command('agent.upsert', { id: 'a', contextUsed: '123' }), NOW), status(400));
});

test('handoff offers cannot smuggle a claim and duplicate offers conflict without mutation', () => {
  const state = offered();
  assert.throws(() => applyCommands(state, command('handoff.offer', { id: 'h', agentId: 'a', title: 'Different' }), NOW), status(409));
  for (const fields of [{ status: 'claimed' }, { owner: 'someone' }, { updatedAt: NOW }]) {
    assert.throws(() => applyCommands(seeded(), command('handoff.offer', { id: 'h', agentId: 'a', title: 'Review', ...fields }), NOW), status(400));
  }
  assert.equal(state.handoffs[0].title, 'Review');
});

test('handoffs claim, release, reassign and complete only for their current owner', () => {
  const offer = offered();
  const claim = applyCommands(offer, command('handoff.claim', { id: 'h', owner: 'reviewer' }), LATER);
  assert.equal(claim.handoffs[0].status, 'claimed');
  assert.equal(offer.handoffs[0].owner, null);
  assert.throws(() => applyCommands(claim, command('handoff.claim', { id: 'h', owner: 'other' }), LATER), status(409));
  for (const type of ['handoff.release', 'handoff.complete']) {
    assert.throws(() => applyCommands(claim, command(type, { id: 'h', owner: 'other' }), LATER), status(409));
    assert.throws(() => applyCommands(offer, command(type, { id: 'h', owner: 'reviewer' }), LATER), status(409));
  }
  const release = applyCommands(claim, command('handoff.release', { id: 'h', owner: 'reviewer' }), LATER);
  assert.equal(release.handoffs[0].owner, null);
  assert.equal(release.handoffs[0].status, 'offered');
  const done = applyCommands(release, [command('handoff.claim', { id: 'h', owner: 'other' }), command('handoff.complete', { id: 'h', owner: 'other' })], LATER);
  assert.equal(done.handoffs[0].status, 'completed');
  assert.equal(done.handoffs[0].owner, 'other');
  assert.throws(() => applyCommands(done, command('handoff.claim', { id: 'h', owner: 'third' }), LATER), status(409));
  assert.throws(() => applyCommands(claim, command('handoff.complete', { id: 'h', owner: 'reviewer' }), NOW), status(400));
  assert.throws(() => applyCommands(offer, command('handoff.claim', { id: 'h', owner: '' }), NOW), status(400));
});

test('a conflicting second claim rolls back earlier actions in the same batch', () => {
  const state = offered();
  const before = structuredClone(state);
  assert.throws(() => applyCommands(state, [command('handoff.claim', { id: 'h', owner: 'one' }), command('handoff.claim', { id: 'h', owner: 'two' })], NOW), status(409));
  assert.deepEqual(state, before);
});

test('attention is resolved explicitly and cannot be reopened by duplicate creation', () => {
  const state = applyCommands(seeded(), command('attention.open', { id: 'n', agentId: 'a', title: 'Decision' }), NOW);
  assert.throws(() => applyCommands(state, command('attention.resolve', { id: 'n' }), EARLIER), status(400));
  const done = applyCommands(state, command('attention.resolve', { id: 'n' }), LATER);
  assert.equal(done.attention[0].resolvedAt, LATER);
  assert.equal(state.attention[0].resolvedAt, null);
  assert.throws(() => applyCommands(done, command('attention.open', { id: 'n', agentId: 'a', title: 'Again' }), LATER), status(409));
  assert.throws(() => applyCommands(done, command('attention.resolve', { id: 'n' }), LATER), status(409));
  assert.throws(() => applyCommands(state, command('attention.resolve', { id: 'missing' }), NOW), status(400));
});

test('snapshots reject duplicate IDs, unknown agents, missing fields and unsafe collection shapes', () => {
  const mutations = [
    state => { state.version = 2; },
    state => { state.revision = -1; },
    state => { state.agents.push(structuredClone(state.agents[0])); },
    state => { delete state.agents[0].status; },
    state => { state.agents[0].unexpected = true; },
    state => { state.events = [{ id: 'e', agentId: 'missing', laneId: 'main', label: '', kind: 'message', startedAt: NOW, endedAt: null, detail: '' }]; },
    state => { state.events = new Array(1); },
    state => { state.events.constructor = 'bad'; },
  ];
  for (const mutate of mutations) {
    const state = seeded();
    mutate(state);
    assert.throws(() => validateSnapshot(state), status(400));
  }
  const original = seeded();
  const clean = validateSnapshot(original);
  clean.agents[0].name = 'Changed';
  assert.equal(original.agents[0].name, 'Agent');
});

test('bounded fields, batches and agent collections reject overflow', () => {
  for (const fields of [{ id: 'x'.repeat(161) }, { id: '' }, { id: 'a', provider: 'x'.repeat(81) }, { id: 'a', name: 'x'.repeat(241) }]) {
    assert.throws(() => applyCommands(emptyState(), command('agent.upsert', fields), NOW), status(400));
  }
  assert.throws(() => applyCommands(emptyState(), Array.from({ length: 1001 }, (_, index) => command('agent.upsert', { id: String(index) })), NOW), status(400));
  const state = applyCommands(emptyState(), Array.from({ length: 500 }, (_, index) => command('agent.upsert', { id: String(index) })), NOW);
  assert.throws(() => applyCommands(state, command('agent.upsert', { id: 'overflow' }), NOW), status(400));
  assert.equal(state.agents.length, 500);
});

test('latest event and run bounds use timestamps, not arrival order', () => {
  let state = seeded();
  for (let batch = 0; batch < 5; batch += 1) {
    state = applyCommands(state, Array.from({ length: 1000 }, (_, index) => command('span.upsert', { id: String(batch * 1000 + index), agentId: 'a' })), NOW);
  }
  state = applyCommands(state, command('span.upsert', { id: 'old', agentId: 'a', startedAt: EARLIER }), NOW);
  assert.equal(state.events.length, 5000);
  assert.equal(state.events.some(item => item.id === 'old'), false);
  state = applyCommands(state, Array.from({ length: 1000 }, (_, index) => command('run.upsert', { id: String(index), agentId: 'a' })), NOW);
  state = applyCommands(state, command('run.upsert', { id: 'newest', agentId: 'a', startedAt: LATER }), LATER);
  assert.equal(state.runs.length, 1000);
  assert.equal(state.runs.some(item => item.id === 'newest'), true);
});

test('unresolved coordination is never silently dropped; finished records can be pruned', () => {
  let state = applyCommands(seeded(), Array.from({ length: 1000 }, (_, index) => command('handoff.offer', { id: String(index), agentId: 'a', title: 'Review' })), NOW);
  const extra = command('handoff.offer', { id: 'next', agentId: 'a', title: 'Next' });
  assert.throws(() => applyCommands(state, extra, NOW), status(400));
  state = applyCommands(state, [command('handoff.claim', { id: '0', owner: 'reviewer' }), command('handoff.complete', { id: '0', owner: 'reviewer' }), extra], NOW);
  assert.equal(state.handoffs.length, 1000);
  assert.equal(state.handoffs.some(item => item.id === '0'), false);
  state = applyCommands(state, Array.from({ length: 1000 }, (_, index) => command('attention.open', { id: String(index), agentId: 'a', title: 'Decision' })), NOW);
  assert.throws(() => applyCommands(state, command('attention.open', { id: 'next', agentId: 'a', title: 'Next' }), NOW), status(400));
  state = applyCommands(state, [command('attention.resolve', { id: '0' }), command('attention.open', { id: 'next', agentId: 'a', title: 'Next' })], NOW);
  assert.equal(state.attention.length, 1000);
  assert.equal(state.attention.some(item => item.id === '0'), false);
});

test('demo is valid, fictional, internally linked and shows parallel lanes with real gaps', () => {
  const state = demoState(NOW);
  assert.deepEqual(validateSnapshot(state), state);
  assert.equal(state.agents.length, 6);
  assert.equal(state.runs.length, 4);
  assert.equal(state.attention.filter(item => item.resolvedAt === null).length, 2);
  assert.equal(state.handoffs.filter(item => item.status === 'offered').length, 3);
  assert.equal(state.handoffs.filter(item => item.status === 'claimed').length, 1);
  assert.ok(state.runs.some(item => item.status === 'failed'));
  assert.ok(state.runs.some(item => item.cost === null));
  assert.ok(state.agents.some(item => item.contextLimit === null));
  const spans = state.events.filter(item => item.agentId === 'atlas-api');
  assert.equal(new Set(spans.map(item => item.laneId)).size, 3);
  const main = spans.filter(item => item.laneId === 'main');
  assert.ok(main.some((item, index) => index > 0 && item.startedAt > main[index - 1].endedAt));
  const child = spans.find(item => item.laneId === 'schema-check');
  assert.ok(main.some(item => item.startedAt < child.endedAt && (item.endedAt === null || item.endedAt > child.startedAt)));
  assert.equal(demoState(LATER).agents[0].lastSeen, '2026-01-15T12:00:56.000Z');
});
