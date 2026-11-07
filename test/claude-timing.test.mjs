import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../lib/adapters.mjs';
import { applyCommands, emptyState, validateSnapshot } from '../lib/model.mjs';

// Minimal synthetic records for the schemas observed in Claude Code 2.1.317.
const at = second => new Date(Date.UTC(2026, 0, 2, 9, 0, second)).toISOString();
const assistant = (second, content = [], extra = {}) => ({ type: 'assistant', uuid: `assistant-${second}`,
  timestamp: at(second), sessionId: 'synthetic-session', message: { content }, ...extra });
const request = (second = 0, extra = {}) => ({ type: 'api-request', id: `request-${second}`,
  sessionId: 'synthetic-session', timestamp: at(second), ...extra });
const parse = rows => parseTranscript(rows.map(JSON.stringify).join('\n'), { provider: 'claude', sourceId: 'synthetic-timing' });
const spans = result => result.commands.filter(command => command.type === 'span.upsert').map(command => command.data);
const agent = result => result.commands.find(command => command.type === 'agent.upsert')?.data;
const thinking = { type: 'thinking', thinking: 'Synthetic reasoning' };

test('reported thinking duration ends at its row timestamp and preserves the existing event ID', () => {
  const row = assistant(60, [thinking], { thinkingDurationMs: 32562 });
  const result = parse([row]);
  const span = spans(result)[0];
  assert.equal(span.startedAt, '2026-01-02T09:00:27.438Z');
  assert.equal(span.endedAt, at(60));
  assert.equal(Date.parse(span.endedAt) - Date.parse(span.startedAt), 32562);
  const { thinkingDurationMs, ...legacy } = row;
  assert.equal(span.id, spans(parse([legacy]))[0].id);
  assert.deepEqual(parse([row, row]).commands, result.commands);
  assert.doesNotThrow(() => validateSnapshot(applyCommands(emptyState(), result.commands)));
});

test('missing duration remains instant; invalid, out-of-range and ambiguous durations warn without inference', () => {
  for (const duration of [undefined, 0, -1, 1.5, '32562', null, true, [], { valueOf: null, toString: null }, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const row = assistant(60, [thinking], duration === undefined ? {} : { thinkingDurationMs: duration });
    const result = parse([row]);
    assert.equal(spans(result)[0].startedAt, spans(result)[0].endedAt);
    if (duration !== undefined && duration !== 0) assert.ok(result.warnings.some(warning => /thinking.*duration/i.test(warning)), JSON.stringify(duration));
  }
  const ambiguous = parse([assistant(60, [thinking, { ...thinking, thinking: 'Second block' }], { thinkingDurationMs: 32562 })]);
  assert.equal(spans(ambiguous).length, 2);
  assert.ok(spans(ambiguous).every(span => span.startedAt === span.endedAt));
  assert.ok(ambiguous.warnings.some(warning => /thinking.*duration/i.test(warning)));
  const early = parse([assistant(60, [thinking], { timestamp: '0000-01-01T00:00:00.000Z', thinkingDurationMs: 1 })]);
  assert.equal(spans(early)[0].startedAt, spans(early)[0].endedAt);
  assert.ok(early.warnings.some(warning => /thinking.*duration/i.test(warning)));
});

test('advisor server invocations pair by ID for a measured subagent interval with stable IDs', () => {
  const call = assistant(0, [{ type: 'server_tool_use', id: 'advisor-1', name: 'advisor', input: { prompt: 'Synthetic task' } }]);
  const output = assistant(60, [{ type: 'advisor_tool_result', tool_use_id: 'advisor-1', content: 'Synthetic advice' }]);
  const result = parse([output, call]);
  const span = spans(result)[0];
  assert.equal(spans(result).length, 1);
  assert.equal(span.kind, 'subagent');
  assert.equal(span.label, 'advisor');
  assert.equal(Date.parse(span.endedAt) - Date.parse(span.startedAt), 60000);
  assert.match(span.detail, /Synthetic task/);
  assert.match(span.detail, /Synthetic advice/);
  assert.equal(span.id, spans(parse([call]))[0].id);
  assert.deepEqual(parse([call, output, call, output]).commands, result.commands);
  assert.doesNotThrow(() => validateSnapshot(applyCommands(emptyState(), result.commands)));
});

test('server tools preserve open, error, duplicate, unmatched and backward-result behavior', () => {
  const call = (second, id, name = 'advisor', input = {}) => assistant(second, [{ type: 'server_tool_use', id, name, input }]);
  const output = (second, id, extra = {}) => assistant(second, [{ type: 'advisor_tool_result', tool_use_id: id, content: 'Synthetic result', ...extra }]);
  const result = parse([call(0, 'failed'), output(60, 'failed', { is_error: true }), call(1, 'other', 'web_search'),
    assistant(3, [{ type: 'tool_result', tool_use_id: 'other', content: 'Search result' }]),
    output(0, 'backward'), call(60, 'backward'), output(2, 'unmatched'), call(4, 'open'),
    call(5, 'open', 'advisor', { repeated: true }),
    assistant(6, [{ type: 'server_tool_use', name: 'advisor' }, { type: 'advisor_tool_result', content: 'No ID' }])]);
  const events = spans(result);
  assert.equal(events.length, 4);
  assert.equal(events.find(span => span.kind === 'error').endedAt, at(60));
  assert.equal(events.find(span => span.label === 'web_search').kind, 'tool');
  assert.equal(events.find(span => span.label === 'web_search').endedAt, at(3));
  assert.equal(events.filter(span => span.endedAt === null).length, 2);
  for (const warning of ['predates', 'no matching invocation', 'repeated tool call ID', 'tool call has no call ID', 'tool result has no call ID']) {
    assert.ok(result.warnings.some(value => value.includes(warning)), warning);
  }
});

test('request-only rows expose a safe instantaneous marker and producer timestamp without request payloads', () => {
  const row = request(60, { cwd: '/synthetic/project', params: { secret: 'DO-NOT-EMIT-PARAMS' }, body: 'DO-NOT-EMIT-BODY' });
  const result = parse([row]);
  assert.equal(agent(result).status, 'working');
  assert.equal(agent(result).lastSeen, at(60));
  assert.equal(agent(result).name, 'Claude synthetic-session');
  assert.equal(agent(result).project, 'project');
  assert.equal(spans(result).length, 1);
  assert.equal(spans(result)[0].label, 'Response requested');
  assert.equal(spans(result)[0].kind, 'message');
  assert.equal(spans(result)[0].startedAt, at(60));
  assert.equal(spans(result)[0].endedAt, at(60));
  assert.equal(spans(result)[0].detail, '');
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-EMIT/);
  assert.equal(spans(parse([{ ...row, params: {} }]))[0].id, spans(result)[0].id);
  assert.deepEqual(parse([row, row]).commands, result.commands);
  assert.doesNotThrow(() => validateSnapshot(applyCommands(emptyState(), result.commands)));
});

test('request lifecycle folds in append order and respects completion, unknown reasons, errors and metadata flags', () => {
  const stopped = reason => assistant(0, [], { message: { stop_reason: reason, content: [] } });
  assert.equal(agent(parse([request(60), stopped('end_turn')])).status, 'idle');
  assert.equal(agent(parse([stopped('end_turn'), request(60)])).status, 'working');
  assert.equal(agent(parse([request(), stopped('future_reason')])).status, 'unknown');
  assert.equal(agent(parse([request(), assistant(1, [], { isApiErrorMessage: true })])).status, 'unknown');
  assert.equal(agent(parse([request(1, { isApiErrorMessage: true })])).status, 'unknown');
  for (const flag of ['isMeta', 'isVisibleInTranscriptOnly', 'isCompactSummary']) {
    assert.equal(agent(parse([stopped('end_turn'), request(60, { [flag]: true })])).status, 'idle');
  }
});

test('malformed requests cannot assert lifecycle or replace lastSeen and safely warn', () => {
  const baseline = assistant(0, [{ type: 'text', text: 'Synthetic completion' }], { message: { stop_reason: 'end_turn', content: [] } });
  for (const extra of [{ id: undefined }, { id: '' }, { id: ' ' }, { id: 42 }, { timestamp: '2026-02-30T09:00:00Z' }]) {
    const result = parse([baseline, request(60, extra)]);
    assert.equal(agent(result).status, 'idle');
    assert.equal(agent(result).lastSeen, at(0));
    assert.equal(spans(result).length, 0);
    assert.ok(result.warnings.some(warning => /malformed|invalid/.test(warning)));
  }
});
