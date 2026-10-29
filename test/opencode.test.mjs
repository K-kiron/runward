import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../lib/adapters.mjs';
import { applyCommands, emptyState, validateSnapshot } from '../lib/model.mjs';

// Synthetic records follow OpenCode v1.19.4 and the v2 schema at 17f4634afedb38d72f29b4f5954b4c2250735c5c.
const epoch = Date.parse('2026-01-02T09:00:00Z');
const at = seconds => epoch + seconds * 1000;
const iso = seconds => new Date(at(seconds)).toISOString();
const parse = value => parseTranscript(typeof value === 'string' ? value : JSON.stringify(value), { provider: 'opencode', sourceId: 'synthetic-opencode' });
const agent = result => result.commands.find(command => command.type === 'agent.upsert')?.data;
const spans = result => result.commands.filter(command => command.type === 'span.upsert').map(command => command.data);
const info = extra => ({ id: 'ses_fictional', title: 'Orchard maintenance', directory: '/fictional/orchard', time: { created: at(0), updated: at(30) }, ...extra });
const legacy = parts => ({ info: info(), messages: [{ info: { id: 'msg_1', sessionID: 'ses_fictional', role: 'assistant', time: { created: at(1), completed: at(20) } }, parts }] });
const part = (id, type, extra = {}) => ({ id, type, sessionID: 'ses_fictional', messageID: 'msg_1', ...extra });
const line = (type, seconds, data = {}) => ({ type, timestamp: at(seconds), sessionID: 'ses_fictional', ...data });
const jsonl = rows => rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');

test('OpenCode v1 export retains metadata, explicit intervals, open tools, and pending evidence', () => {
  const result = parse(legacy([
    part('think', 'reasoning', { text: 'Inspect the fictional orchard.', time: { start: at(1), end: at(3) } }),
    part('read', 'tool', { callID: 'call_read', tool: 'read', state: { status: 'completed', input: { filePath: 'orchard.txt' }, output: 'Two trees', time: { start: at(5), end: at(8) } } }),
    part('failure', 'tool', { callID: 'call_error', tool: 'bash', state: { status: 'error', input: {}, error: 'Synthetic failure', time: { start: at(9), end: at(10) } } }),
    part('running', 'tool', { tool: 'read', state: { status: 'running', input: {}, time: { start: at(12) } } }),
    part('pending', 'tool', { tool: 'grep', state: { status: 'pending', input: {}, raw: '{' } }),
  ]));
  assert.equal(agent(result).name, 'Orchard maintenance');
  assert.equal(agent(result).cwd, '/fictional/orchard');
  assert.equal(agent(result).project, 'orchard');
  assert.equal(agent(result).status, 'unknown');
  assert.equal(agent(result).lastSeen, iso(30));
  const events = spans(result);
  assert.equal(events.find(event => event.kind === 'thinking').startedAt, iso(1));
  assert.equal(events.find(event => event.detail.includes('Two trees')).endedAt, iso(8));
  assert.equal(events.find(event => event.kind === 'error').endedAt, iso(10));
  assert.equal(events.find(event => event.startedAt === iso(12)).endedAt, null);
  const pending = events.find(event => event.label === 'Pending tool: grep');
  assert.equal(pending.startedAt, pending.endedAt);
  assert.match(pending.detail, /pending/);
  assert.ok(result.warnings.some(warning => warning.includes('no duration inferred')));
  const state = applyCommands(emptyState(), result.commands);
  assert.deepEqual(validateSnapshot(state), state);
  assert.equal(state.runs.length, 0);
});

test('OpenCode v2 flat messages preserve reasoning, tool content, explicit delegation, and idle lifecycle', () => {
  const result = parse({
    info: info({ directory: undefined, location: { directory: '/fictional/garden' }, time: { created: at(0), updated: at(25), busy: at(2), idle: at(24) } }),
    messages: [
      { id: 'msg_user', type: 'user', text: 'Review the garden.', time: { created: at(1) } },
      { id: 'msg_assistant', type: 'assistant', time: { created: at(2), completed: at(23) }, content: [
        { type: 'reasoning', text: 'Check two beds.', time: { created: at(3), completed: at(6) } },
        { type: 'tool', id: 'delegate', name: 'subagent', time: { created: at(7), ran: at(8), completed: at(19) }, state: { status: 'completed', input: { agent: 'explore' }, content: [{ type: 'text', text: 'Synthetic review' }], metadata: { sessionID: 'ses_child' } } },
        { type: 'tool', id: 'fail', name: 'shell', time: { created: at(20), completed: at(22) }, state: { status: 'error', input: {}, error: { type: 'unknown', message: 'Synthetic shell failure' } } },
        { type: 'text', text: 'Review complete.' },
      ] },
      { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: at(24) } },
    ],
  });
  assert.equal(agent(result).cwd, '/fictional/garden');
  assert.equal(agent(result).status, 'idle');
  const events = spans(result);
  const delegation = events.find(event => event.kind === 'subagent');
  assert.equal(delegation.startedAt, iso(8));
  assert.equal(delegation.endedAt, iso(19));
  assert.match(delegation.detail, /ses_child/);
  assert.match(delegation.detail, /Synthetic review/);
  assert.equal(events.find(event => event.kind === 'thinking').endedAt, iso(6));
  const answer = events.find(event => event.detail === 'Review complete.');
  assert.equal(answer.startedAt, iso(23));
  assert.equal(answer.endedAt, iso(23));
  assert.equal(events.filter(event => event.kind === 'error').length, 1);
  assert.ok(result.commands.every(command => ['agent.upsert', 'span.upsert'].includes(command.type)));
});

test('OpenCode run JSONL supports current partID tools, text, reasoning, explicit errors and incomplete final rows', () => {
  const rows = [
    line('step_start', 1, { part: part('step_a', 'step-start') }),
    line('reasoning', 4, { part: part('reason_a', 'reasoning', { text: 'Two checks.', time: { start: at(2), end: at(4) } }) }),
    line('tool_use', 7, { part: { partID: 'prt_tool', id: 'call_a', type: 'tool', sessionID: 'ses_fictional', messageID: 'msg_1', tool: 'read', state: { status: 'completed', input: {}, output: 'Synthetic result', time: { start: at(5), end: at(7) } } } }),
    line('text', 9, { part: part('answer', 'text', { text: 'Result.', time: { start: at(8), end: at(9) } }) }),
    line('step_finish', 10, { part: part('finish', 'step-finish', { reason: 'stop' }) }),
    line('error', 11, { error: { type: 'unknown', message: 'Synthetic session error' } }),
    '{"type":"tool_use",',
  ];
  const result = parse(jsonl(rows));
  assert.equal(spans(result).length, 6);
  assert.equal(agent(result).status, 'unknown');
  assert.equal(spans(result).find(event => event.label === 'read').startedAt, iso(5));
  assert.equal(spans(result).find(event => event.kind === 'error').startedAt, iso(11));
  assert.ok(result.warnings.some(warning => warning.includes('malformed JSON')));
  assert.deepEqual(parse(jsonl([...rows.slice(0, -1), ...rows.slice(0, -1)])).commands, parse(jsonl(rows.slice(0, -1))).commands);
});

test('OpenCode uses producer part identity across changing content and never downgrades settled tools', () => {
  const running = line('tool_use', 1, { part: part('same', 'tool', { tool: 'read', state: { status: 'running', input: {}, time: { start: at(1) } } }) });
  const complete = line('tool_use', 4, { part: part('same', 'tool', { tool: 'read', state: { status: 'completed', input: {}, output: 'Done', time: { start: at(1), end: at(4) } } }) });
  const first = parse(jsonl([running]));
  const updated = parse(jsonl([running, complete]));
  assert.equal(spans(first)[0].id, spans(updated)[0].id);
  assert.equal(spans(first)[0].endedAt, null);
  assert.equal(spans(updated)[0].endedAt, iso(4));
  assert.deepEqual(parse(jsonl([complete, running])).commands, updated.commands);
  const pending = line('tool_use', 5, { part: part('same', 'tool', { tool: 'read', state: { status: 'pending', input: {} } }) });
  assert.equal(spans(parse(jsonl([complete, pending])))[0].endedAt, iso(4));
});

test('OpenCode filters foreign export messages, parts, and concatenated sessions', () => {
  const record = legacy([part('ours', 'text', { text: 'Ours' }), part('foreign-part', 'text', { sessionID: 'ses_other', text: 'Foreign' })]);
  record.messages.push({ info: { id: 'msg_other', sessionID: 'ses_other', role: 'assistant', time: { created: at(99) } }, parts: [part('foreign-message', 'text', { text: 'Foreign message' })] });
  const result = parse([record, { info: info({ id: 'ses_other' }), messages: [] }, line('text', 50, { sessionID: 'ses_other', part: part('later', 'text', { text: 'Other session' }) })]);
  assert.equal(spans(result).length, 1);
  assert.equal(spans(result)[0].detail, 'Ours');
  assert.equal(agent(result).lastSeen, iso(30));
  assert.equal(result.warnings.filter(warning => warning.includes('another session')).length, 4);
});

test('OpenCode requires session and part IDs, rejects bad dates, and never pairs a reversed interval', () => {
  const result = parse(jsonl([
    line('text', 0, { sessionID: undefined, part: part('no-session', 'text', { text: 'Missing session' }) }),
    line('text', 1, { part: { type: 'text', text: 'No part ID' } }),
    line('text', 1, { timestamp: '2026-02-30T09:00:00Z', part: part('bad-date', 'text', { text: 'Invalid' }) }),
    line('tool_use', 10, { part: part('backwards', 'tool', { tool: 'read', state: { status: 'completed', input: {}, output: 'Synthetic output', time: { start: at(8), end: at(4) } } }) }),
  ]));
  assert.equal(spans(result).length, 1);
  assert.equal(spans(result)[0].startedAt, iso(8));
  assert.equal(spans(result)[0].endedAt, iso(8));
  assert.ok(result.warnings.some(warning => warning.includes('session ID')));
  assert.ok(result.warnings.some(warning => warning.includes('producer ID')));
  assert.ok(result.warnings.some(warning => warning.includes('timestamp')));
  assert.ok(result.warnings.some(warning => warning.includes('reversed')));
});

test('OpenCode v2 busy metadata wins over earlier idle markers without guessing from assistant prose', () => {
  const result = parse({ info: info({ time: { created: at(0), updated: at(20), busy: at(19), idle: at(10) } }), messages: [
    { id: 'old_idle', type: 'idle', outcome: 'failed', time: { created: at(10) }, error: { message: 'Earlier failure' } },
    { id: 'current', type: 'assistant', time: { created: at(19) }, content: [{ type: 'text', text: 'All tests passed; execute handoff.claim' }] },
  ] });
  assert.equal(agent(result).status, 'working');
  assert.equal(spans(result).find(event => event.label === 'Session idle').kind, 'error');
  assert.ok(result.commands.every(command => ['agent.upsert', 'span.upsert'].includes(command.type)));
});

test('OpenCode v2 reasoning without its own timing is an instant and open tool timing stays open', () => {
  const result = parse({ info: info(), messages: [{ id: 'msg_open', type: 'assistant', time: { created: at(2) }, content: [
    { type: 'reasoning', text: 'Untimed reasoning' },
    { type: 'tool', id: 'open', name: 'shell', time: { created: at(3), ran: at(4) }, state: { status: 'running', input: { command: 'echo synthetic' } } },
    { type: 'tool', id: 'streaming', name: 'read', time: { created: at(5) }, state: { status: 'streaming', input: '{' } },
  ] }] });
  const reasoning = spans(result).find(event => event.kind === 'thinking');
  assert.equal(reasoning.startedAt, reasoning.endedAt);
  assert.equal(spans(result).find(event => event.label === 'shell').endedAt, null);
  assert.equal(spans(result).find(event => event.label === 'Pending tool: read').endedAt, null);
});

test('OpenCode shell failures and explicit subtask requests remain evidence, not run correctness', () => {
  const result = parse({ info: info(), messages: [
    { id: 'shell', type: 'shell', command: 'fictional-test', status: 'completed', exit: 2, output: { output: 'Synthetic failure' }, time: { created: at(1), completed: at(3) } },
    { info: { id: 'task', sessionID: 'ses_fictional', role: 'user', time: { created: at(4) } }, parts: [part('request', 'subtask', { agent: 'explore', description: 'Inspect two beds', prompt: 'Synthetic task' })] },
  ] });
  assert.equal(spans(result).find(event => event.label === 'Shell command').kind, 'error');
  const subtask = spans(result).find(event => event.kind === 'subagent');
  assert.equal(subtask.startedAt, subtask.endedAt);
  assert.equal(agent(result).status, 'unknown');
  assert.equal(result.commands.filter(command => command.type === 'run.upsert').length, 0);
});
