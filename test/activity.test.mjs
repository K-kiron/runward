import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTime, awaitingEventRange, eventActivityTime, groupActivityByProvider, recentActivity } from '../public/activity.mjs';

const now = Date.parse('2026-01-15T12:00:00.000Z');
const at = secondsAgo => new Date(now - secondsAgo * 1000).toISOString();
const agent = (id, secondsAgo, status = 'unknown') => ({ id, lastSeen: at(secondsAgo), status });
const span = (id, agentId, secondsAgo, endAgo = null) => ({ id, agentId, startedAt: at(secondsAgo), endedAt: endAgo === null ? null : at(endAgo) });
const snapshot = (agents, events = [], extra = {}) => ({ agents, events, runs: [], handoffs: [], attention: [], ...extra });
const ids = data => data.agents.map(agent => agent.id);

test('recent reported working state gets a separate waiting range without extending recorded spans', () => {
  const source = snapshot([agent('busy', 45, 'working')], [span('completed', 'busy', 50, 45)]);
  const view = recentActivity(source, { now });
  assert.deepEqual(awaitingEventRange(view.agents[0], view.latestActivity.get('busy'), now), { start: now - 45_000, end: now });
  assert.equal(eventActivityTime(source.events[0], now), now - 45_000);
  assert.equal(view.latestActivity.get('busy'), now - 45_000);
  assert.deepEqual(awaitingEventRange(view.agents[0], view.latestActivity.get('busy'), now + 10_000), { start: now - 45_000, end: now + 10_000 });
  assert.equal(awaitingEventRange(view.agents[0], view.latestActivity.get('busy'), now + 75_001), null);
  assert.deepEqual(recentActivity(source, { now: now + 300_000 }).agents, []);
});

test('waiting range requires fresh, valid working evidence and never revives another state', () => {
  for (const status of ['idle', 'waiting', 'offline', 'unknown', 'stale']) {
    assert.equal(awaitingEventRange(agent('a', 1, status), now - 1000, now), null);
  }
  for (const latest of [null, undefined, NaN, Infinity, '2026-01-15T12:00:00Z', now + 1, now - 120_001]) {
    assert.equal(awaitingEventRange(agent('a', 1, 'working'), latest, now), null);
  }
  assert.deepEqual(awaitingEventRange(agent('a', 120, 'working'), now - 120_000, now), { start: now - 120_000, end: now });
});

test('default shows only recent sessions, newest first, retaining unknown lifecycle', () => {
  const source = snapshot([agent('old', 301), agent('first-imported', 90, 'working'), agent('newest', 2), agent('boundary', 300)]);
  const view = recentActivity(source, { now });
  assert.deepEqual(ids(view), ['newest', 'first-imported', 'boundary']);
  assert.equal(view.agents[0].status, 'unknown');
  assert.deepEqual(source.agents.map(agent => agent.id), ['old', 'first-imported', 'newest', 'boundary']);
  assert.deepEqual(view.range, { start: now - 300_000, end: now });
});

test('idle sessions expire without incoming updates and reappear/reorder on real activity', () => {
  const source = snapshot([agent('a', 299), agent('b', 1)]);
  assert.deepEqual(ids(recentActivity(source, { now })), ['b', 'a']);
  assert.deepEqual(ids(recentActivity(source, { now: now + 2000 })), ['b']);
  const next = { ...source, events: [span('new-output', 'a', -2)] };
  const view = recentActivity(next, { now: now + 2000 });
  assert.deepEqual(ids(view), ['a', 'b']);
  assert.equal(view.latestActivity.get('a'), now + 2000);
  assert.deepEqual(ids(recentActivity(next, { now: now + 303_000 })), []);
});

test('open old spans never become activity because their end is missing or a file was touched', () => {
  const source = snapshot([{ ...agent('idle', 3600), mtime: at(0) }], [{ ...span('old-open', 'idle', 3600), updatedAt: at(0) }]);
  assert.equal(eventActivityTime(source.events[0], now), now - 3_600_000);
  assert.deepEqual(ids(recentActivity(source, { now })), []);
  assert.deepEqual(ids(recentActivity(source, { now: now + 60_000 })), []);
  const active = snapshot([agent('idle', 1)], source.events);
  assert.deepEqual(recentActivity(active, { now }).events, []);
});

test('real span endpoints can admit a session and filter the timeline to the same window', () => {
  const source = snapshot([agent('a', 3600)], [span('old', 'a', 3600, 3500), span('finished-now', 'a', 3600, 1), span('recent-open', 'a', 5)]);
  const view = recentActivity(source, { now });
  assert.deepEqual(ids(view), ['a']);
  assert.equal(view.latestActivity.get('a'), now - 1000);
  assert.deepEqual(view.events.map(event => event.id), ['finished-now', 'recent-open']);
});

test('invalid, ambiguous and future timestamps cannot keep sessions visible', () => {
  for (const value of [undefined, null, 123, '', 'nonsense', '2026-01-15', '2026-01-15T11:59:59', '2025-02-30T00:00:00Z', '2026-01-15T24:00:00Z', at(-1)]) assert.equal(activityTime(value, now), null, String(value));
  assert.equal(activityTime('2026-01-15T07:00:00-05:00', now), now);
  const source = snapshot([{ id: 'future', lastSeen: at(-1) }, { id: 'invalid', lastSeen: 'bad' }, agent('old', 3600)], [
    span('future-start', 'old', -1), span('future-end', 'old', 3600, -1),
    { ...span('invalid-start', 'invalid', 1, 0), startedAt: 'bad' },
  ]);
  assert.deepEqual(ids(recentActivity(source, { now })), []);
  const validEvidence = { ...source, events: [span('valid', 'future', 1)] };
  assert.deepEqual(ids(recentActivity(validEvidence, { now })), ['future']);
});

test('window choices widen admission/timeline and tie ordering is deterministic', () => {
  const source = snapshot([agent('z', 0), agent('a', 0), agent('fifteen', 600), agent('hour', 1800)], [span('older-output', 'z', 600)]);
  assert.deepEqual(ids(recentActivity(source, { now })), ['a', 'z']);
  const quarterHour = recentActivity(source, { now, windowMinutes: '15' });
  assert.deepEqual(ids(quarterHour), ['a', 'z', 'fifteen']);
  assert.equal(quarterHour.events.length, 1);
  assert.deepEqual(ids(recentActivity(source, { now, windowMinutes: '60' })), ['a', 'z', 'fifteen', 'hour']);
  assert.deepEqual(ids(recentActivity(source, { now, windowMinutes: 'all' })), ['a', 'z']);
});

test('runs and coordination queues use the visible session scope', () => {
  const source = snapshot([agent('active', 0), agent('expired', 301)], [], Object.fromEntries(['runs', 'handoffs', 'attention'].map(key => [key, [
    { id: `${key}-active`, agentId: 'active', createdAt: at(3600) }, { id: `${key}-expired`, agentId: 'expired', createdAt: at(0) },
  ]])));
  const view = recentActivity(source, { now });
  for (const key of ['runs', 'handoffs', 'attention']) assert.deepEqual(view[key].map(item => item.agentId), ['active']);
  const expired = recentActivity(source, { now: now + 300_001 });
  for (const key of ['agents', 'runs', 'handoffs', 'attention', 'events']) assert.deepEqual(expired[key], []);
});

test('platform regions show only visible sources in stable platform order, newest within each', () => {
  const withProvider = (id, age, provider) => ({ ...agent(id, age), provider });
  const source = snapshot([
    withProvider('claude-new', 0, 'claude'), withProvider('codex-old', 200, 'codex'),
    withProvider('other-z', 1, 'Zeta'), withProvider('codex-new', 20, 'Codex'),
    withProvider('claude-old', 10, 'Claude Code'), withProvider('other-a', 2, 'Alpha'),
    withProvider('expired', 301, 'Gemini'),
  ]);
  const view = recentActivity(source, { now });
  const groups = groupActivityByProvider(view.agents, view.latestActivity);
  assert.deepEqual(groups.map(group => group.label), ['Codex', 'Claude Code', 'Alpha', 'Zeta']);
  assert.deepEqual(groups.map(group => group.agents.map(agent => agent.id)), [['codex-new', 'codex-old'], ['claude-new', 'claude-old'], ['other-a'], ['other-z']]);
  assert.equal(groups.reduce((count, group) => count + group.agents.length, 0), view.agents.length);
  assert.deepEqual(groupActivityByProvider([...view.agents].reverse(), view.latestActivity), groups);
  assert.deepEqual(groupActivityByProvider(view.agents.filter(agent => agent.provider === 'claude'), view.latestActivity).map(group => group.label), ['Claude Code']);
  assert.deepEqual(groupActivityByProvider([], view.latestActivity), []);
});

test('unknown platforms have an explicit fallback and platform grouping preserves input and activity tie order', () => {
  const agents = [
    { ...agent('unknown-z', 1), provider: ' ' }, { ...agent('custom', 0), provider: '<custom platform>' },
    { ...agent('unknown-a', 1), provider: null }, { ...agent('missing', 2) },
  ];
  const view = recentActivity(snapshot(agents), { now });
  const originalIds = ids(view);
  const groups = groupActivityByProvider(view.agents, view.latestActivity);
  assert.deepEqual(groups.map(group => group.label), ['<custom platform>', 'Unknown platform']);
  assert.deepEqual(groups[1].agents.map(agent => agent.id), ['unknown-a', 'unknown-z', 'missing']);
  assert.deepEqual(ids(view), originalIds);
});
