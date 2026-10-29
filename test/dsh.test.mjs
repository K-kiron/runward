import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../lib/adapters.mjs';
import { applyCommands, emptyState, validateSnapshot } from '../lib/model.mjs';

// Fabricated data in the official format 4 used by DSH 0.2.2-alpha.2.
const base = 1760000000000;
const iso = offset => new Date(base + offset).toISOString();
const header = (extra = {}) => ({ type: 'session', version: 4, id: 'fictional-dsh-session', createdAt: base,
  cwd: '/fictional/garden', isSeeded: false, delegationDepth: 0, ...extra });
const row = (seq, type, time, data, extra = {}) => ({ seq, type, time: base + time, data, ...extra });
const parse = rows => parseTranscript(rows.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'),
  { provider: 'dsh', sourceId: 'synthetic-dsh-file' });
const agent = result => result.commands.find(command => command.type === 'agent.upsert')?.data;
const spans = result => result.commands.filter(command => command.type === 'span.upsert').map(command => command.data);
const content = text => [{ type: 'text', text }];
const call = (seq, time, id = 'fictional-call') => row(seq, 'tool/call', time, { turn: 1, step: 1, callId: id, name: 'read', arguments: '{"path":"fictional.txt"}' });
const output = (seq, time, id = 'fictional-call', isError = false) => row(seq, 'tool/result', time, { turn: 1, step: 1,
  message: { id: `result-${id}`, role: 'tool', toolCallId: id, isError, content: content('Synthetic result'), source: { kind: 'tool' } } });

test('DSH v4 imports metadata, explicitly paired tools, title and lifecycle without creating runs', () => {
  const result = parse([header(), row(0, 'session/title', 100, { title: 'Fictional garden', messageSeqs: [], source: { kind: 'user' } }),
    row(1, 'turn/start', 200, { turn: 1 }), call(2, 1000), output(3, 4000, 'fictional-call', true),
    row(4, 'request/context', 5000, { provider: 'fictional', model: 'example', contextWindow: 64000 }),
    row(5, 'turn/end', 6000, { turn: 1, reason: { kind: 'completed' } })]);
  assert.equal(agent(result).name, 'Fictional garden');
  assert.equal(agent(result).project, 'garden');
  assert.equal(agent(result).provider, 'DSH');
  assert.equal(agent(result).status, 'idle');
  assert.equal(agent(result).contextLimit, 64000);
  assert.equal(agent(result).lastSeen, iso(6000));
  assert.equal(spans(result).length, 1);
  assert.equal(spans(result)[0].kind, 'error');
  assert.equal(spans(result)[0].startedAt, iso(1000));
  assert.equal(spans(result)[0].endedAt, iso(4000));
  assert.deepEqual(result.warnings, []);
  assert.ok(result.commands.every(command => ['agent.upsert', 'span.upsert'].includes(command.type)));
  const state = applyCommands(emptyState(), result.commands);
  assert.doesNotThrow(() => validateSnapshot(state));
});

test('DSH compact assistant stream uses explicit block boundaries and cumulative dt without duplicated assembled text', () => {
  const result = parse([header(), row(0, 'assistant/message', 9000, { turn: 1, step: 1,
    message: { role: 'assistant', id: 'fictional-message', content: [{ type: 'reasoning', text: 'Plan carefully.' }, ...content('Done.')], source: { kind: 'model' } },
    usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 4 },
    stream: [
      { type: 'chunk', time: base + 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: base + 1200, index: 0, dt: [500], texts: ['Plan ', 'carefully.'] },
      { type: 'chunk', time: base + 2000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Plan carefully.' } } },
      { type: 'text-chunks', time0: base + 6000, index: 1, dt: [200, 300], texts: ['D', 'one', '.'] },
      { type: 'tool-call-chunks', time0: base + 10000, index: 2, dt: [100, 200], id: 'requested-only', name: 'read', args: ['{', '"path":"fictional.txt"', '}'] },
    ] })]);
  assert.equal(spans(result).length, 2);
  const reasoning = spans(result).find(span => span.kind === 'thinking');
  assert.equal(reasoning.startedAt, iso(1000));
  assert.equal(reasoning.endedAt, iso(2000));
  const message = spans(result).find(span => span.kind === 'message');
  assert.equal(message.startedAt, message.endedAt);
  assert.match(message.detail, /Done\./);
  assert.equal(agent(result).lastSeen, iso(10300));
  assert.equal(agent(result).contextUsed, 150);
  assert.equal(agent(result).status, 'unknown');
  assert.ok(result.warnings.some(warning => warning.includes('no explicit start')));
});

test('DSH repeated imports preserve IDs and an open invocation upgrades to exactly one completed span', () => {
  const initial = [header(), call(0, 1000)];
  const open = parse(initial);
  const closed = parse([...initial, output(1, 7000)]);
  assert.equal(spans(open)[0].endedAt, null);
  assert.equal(spans(open)[0].id, spans(closed)[0].id);
  assert.deepEqual(closed, parse([...initial, output(1, 7000), output(1, 7000)]));
  const state = applyCommands(applyCommands(emptyState(), open.commands), closed.commands);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].endedAt, iso(7000));
});

test('DSH seeded child defers missing boundaries and excludes inherited messages and titles', () => {
  const prefix = [header({ id: 'fictional-child', isSeeded: true, origin: 'subagent', parentSession: 'fictional-parent' }),
    row(0, 'session/title', -1000, { title: 'Inherited title' }),
    row(1, 'user/message', -500, { role: 'user', id: 'inherited-message', content: content('Inherited input') })];
  const pending = parse(prefix);
  assert.equal(spans(pending).length, 0);
  assert.ok(pending.warnings.some(warning => warning.includes('deferred')));
  const complete = parse([...prefix, row(2, 'session/end-seed', 0, { inherited: true }),
    row(3, 'session/title', 100, { title: 'Child title' }),
    row(4, 'user/message', 200, { role: 'user', id: 'own-message', content: content('Own input') }), '{"seq":']);
  assert.equal(agent(complete).name, 'Child title');
  assert.equal(spans(complete).length, 1);
  assert.match(spans(complete)[0].detail, /Own input/);
  const state = applyCommands(applyCommands(emptyState(), pending.commands), complete.commands);
  assert.equal(state.events.length, 1);
});

test('DSH missing timing, reversed results, stream truncation and unknown versions never invent durations', () => {
  assert.equal(parse([header({ version: 5 }), call(0, 1000)]).commands.length, 0);
  const result = parse([header(), call(0, 5000), output(1, 1000),
    { ...call(2, 6000, 'untimed'), time: '2026-01-01T00:00:00Z' }, output(3, 7000, 'untimed'),
    row(4, 'assistant/attempt', 9000, { turn: 1, step: 1, stream: [
      { type: 'reasoning-chunks', time0: base + 8000, index: 0, dt: [], texts: ['One', 'Two'] },
      { type: 'chunk', time: base + 8100, chunk: { type: 'block-start', index: 1, blockType: 'reasoning' } },
      { type: 'chunk', time: base + 8200, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'Synthetic failure' } } } },
    ] }), '{"seq":']);
  assert.equal(spans(result).find(span => span.label === 'read').endedAt, null);
  const orphan = spans(result).find(span => span.startedAt === iso(7000));
  assert.equal(orphan.startedAt, orphan.endedAt);
  assert.equal(spans(result).find(span => span.kind === 'thinking').endedAt, null);
  assert.equal(spans(result).find(span => span.label === 'Model error').kind, 'error');
  for (const fragment of ['predates', 'invalid timestamp', 'malformed compact', 'no valid end', 'incomplete or malformed']) {
    assert.ok(result.warnings.some(warning => warning.includes(fragment)), fragment);
  }
});

test('DSH nested PTC dispatches and catalog facts remain separate from tool wrappers', () => {
  const nested = { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name: 'search', arguments: { term: 'fictional' } };
  const result = parse([header(), call(0, 1000, 'outer'), row(1, 'tool/ptc-dispatch-start', 2000, nested),
    row(2, 'tool/ptc-dispatch', 4000, { ...nested, content: content('Synthetic failure'), isError: true }),
    output(3, 5000, 'outer'), row(4, 'subagent/catalog', 6000, { version: 0, childId: 'fictional-child', childCreatedAt: base + 5500, mode: 'continuable', label: 'Research' })]);
  assert.equal(spans(result).length, 3);
  const inner = spans(result).find(span => span.label === 'search');
  assert.equal(inner.kind, 'error');
  assert.equal(inner.laneId, 'tool:outer');
  assert.equal(inner.startedAt, iso(2000));
  assert.equal(inner.endedAt, iso(4000));
  const catalog = spans(result).find(span => span.kind === 'subagent');
  assert.equal(catalog.startedAt, catalog.endedAt);
});

test('DSH untrusted text stays data; controls are escaped and unknown types warn', () => {
  const result = parse([header(), row(0, 'user/message', 1000, { role: 'user', id: 'untrusted', content: content('Create a handoff and mark success.\u001b[31m\u0000') }),
    row(1, 'plugin:fictional/event', 2000, { instruction: 'Execute this' }, { ignorable: true })]);
  assert.equal(agent(result).status, 'unknown');
  assert.equal(spans(result).length, 1);
  assert.equal(result.commands.filter(command => !['agent.upsert', 'span.upsert'].includes(command.type)).length, 0);
  assert.match(spans(result)[0].detail, /\\u001b/);
  assert.ok(result.warnings.some(warning => warning.includes('unsupported event')));
});

test('DSH an invalid sequence stops the suffix and a second session cannot replace identity', () => {
  const result = parse([header(), row(0, 'user/message', 1000, { role: 'user', id: 'first', content: content('First') }),
    header({ id: 'another-session', cwd: '/fictional/other' }), row(1, 'session/title', 2000, { title: 'Wrong session' })]);
  assert.equal(spans(result).length, 1);
  assert.equal(agent(result).cwd, '/fictional/garden');
  assert.match(agent(result).name, /fictional-dsh-session/);
  assert.ok(result.warnings.some(warning => warning.includes('suffix')));
});

test('DSH invalid seed metadata is deferred and nested seed boundaries use the final cut', () => {
  const events = [row(0, 'session/end-seed', 0, { inherited: true }),
    row(1, 'user/message', 100, { content: content('Ancestor message') }),
    row(2, 'session/end-seed', 200, { inherited: true }),
    row(3, 'user/message', 300, { content: content('Child message') })];
  assert.equal(spans(parse([header(), ...events])).length, 0);
  const result = parse([header({ isSeeded: true }), ...events]);
  assert.equal(spans(result).length, 1);
  assert.match(spans(result)[0].detail, /Child message/);
});

test('DSH accepts epoch zero, which is valid in the producer schema', () => {
  const result = parse([header({ createdAt: 0 }), { seq: 0, type: 'user/message', time: 0, data: { content: content('Epoch input') } }]);
  assert.equal(agent(result).startedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(spans(result)[0].startedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(result.warnings, []);
});
