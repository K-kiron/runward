import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTranscript } from '../lib/adapters.mjs';
import { applyCommands, emptyState, validateSnapshot } from '../lib/model.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parse = (rows, provider = 'codex', options = {}) => parseTranscript(rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'), { provider, sourceId: 'synthetic-source', ...options });
const agent = (result) => result.commands.find((command) => command.type === 'agent.upsert')?.data;
const spans = (result) => result.commands.filter((command) => command.type === 'span.upsert').map((command) => command.data);
const event = (at, payload) => ({ timestamp: at, type: 'response_item', payload });
const start = '2026-01-02T09:00:00Z';
const end = '2026-01-02T09:00:05Z';

test('Claude imports metadata, instantaneous thinking, paired tools, and explicit input usage', () => {
  const result = parseTranscript(fixture('claude-session.jsonl'), { provider: 'claude', sourceId: 'fixture-claude' });
  assert.equal(agent(result).project, 'fictional-orchard');
  assert.equal(agent(result).contextUsed, 150);
  assert.equal(agent(result).contextLimit, null);
  assert.equal(agent(result).status, 'unknown');
  assert.equal(agent(result).lastSeen, '2026-01-02T09:00:10.000Z');
  const read = spans(result).find((span) => span.label === 'Read');
  assert.equal(Date.parse(read.endedAt) - Date.parse(read.startedAt), 3000);
  assert.match(read.detail, /Two fictional rows/);
  const thinking = spans(result).find((span) => span.kind === 'thinking');
  assert.equal(thinking.startedAt, thinking.endedAt);
  assert.equal(spans(result).find((span) => span.label === 'Bash').endedAt, null);
  assert.ok(result.commands.every((command) => ['agent.upsert', 'span.upsert'].includes(command.type)));
});

test('Codex imports lifecycle, preserves gaps, and does not report task correctness from completion', () => {
  const result = parseTranscript(fixture('codex-rollout.jsonl'), { provider: 'codex', sourceId: 'fixture-codex' });
  assert.equal(agent(result).project, 'fictional-garden');
  assert.equal(agent(result).status, 'idle');
  assert.equal(agent(result).contextUsed, 300);
  assert.equal(agent(result).contextLimit, 100000);
  const tool = spans(result).find((span) => span.kind === 'tool');
  assert.equal(tool.startedAt, '2026-01-02T09:00:02.000Z');
  assert.equal(tool.endedAt, '2026-01-02T09:00:05.000Z');
  assert.ok(spans(result).every((span) => span.kind === 'tool' || span.startedAt === span.endedAt));
  assert.ok(result.commands.every((command) => ['agent.upsert', 'span.upsert'].includes(command.type)));
});

test('outputs may precede calls in file order; timestamp ordering and IDs determine pairing', () => {
  const result = parse([
    event(end, { type: 'function_call_output', call_id: 'b', output: 'second' }),
    event(start, { type: 'function_call', call_id: 'a', name: 'first', arguments: '{}' }),
    event(start, { type: 'function_call', call_id: 'b', name: 'second', arguments: '{}' }),
    event(end, { type: 'function_call_output', call_id: 'a', output: 'first' }),
  ]);
  assert.equal(spans(result).length, 2);
  for (const span of spans(result)) { assert.match(span.detail, new RegExp(`Result:\\n${span.label}`)); assert.equal(span.endedAt, '2026-01-02T09:00:05.000Z'); }
  assert.equal(agent(result).lastSeen, '2026-01-02T09:00:05.000Z');
});

test('unmatched outputs and backwards timestamps never manufacture durations', () => {
  const result = parse([
    event(start, { type: 'function_call_output', call_id: 'backwards', output: 'early' }),
    event(end, { type: 'function_call', call_id: 'backwards', name: 'late', arguments: '{}' }),
    event(end, { type: 'function_call_output', call_id: 'orphan', output: 'alone' }),
    event(end, { type: 'function_call', call_id: 'open', name: 'open', arguments: '{}' }),
  ]);
  assert.equal(spans(result).length, 2);
  assert.ok(spans(result).every((span) => span.endedAt === null));
  assert.ok(result.warnings.some((warning) => warning.includes('predates')));
  assert.ok(result.warnings.some((warning) => warning.includes('no matching invocation')));
});

test('valid rows survive malformed middle rows and a truncated final record', () => {
  const result = parse([
    event(start, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    '{broken}', null, '{"type":',
  ]);
  assert.equal(spans(result).length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('Line 2: invalid JSON')));
  assert.ok(result.warnings.some((warning) => warning.includes('Line 3: expected a JSON object')));
  assert.ok(result.warnings.some((warning) => warning.includes('Line 4: incomplete or malformed')));
});

test('timestamps require an explicit zone and a valid calendar date; offsets normalize to UTC', () => {
  const message = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] };
  const result = parse([event('2026-02-30T01:00:00Z', message), event('2026-01-02T01:00:00', message), event('2026-01-02T04:00:00-05:00', message), event(undefined, message)]);
  assert.equal(spans(result).length, 1);
  assert.equal(agent(result).lastSeen, '2026-01-02T09:00:00.000Z');
  assert.equal(result.warnings.filter((warning) => warning.includes('timestamp')).length, 4);
});

test('repeated imports and duplicate records produce stable IDs and unchanged commands', () => {
  const source = fixture('codex-rollout.jsonl');
  const options = { provider: 'codex', sourceId: 'stable', project: 'Chosen project' };
  const first = parseTranscript(source, options);
  assert.deepEqual(parseTranscript(source, options), first);
  assert.deepEqual(parseTranscript(`${source}${source}`, options).commands, first.commands);
  assert.equal(agent(first).project, 'Chosen project');
  assert.notEqual(agent(parseTranscript(source, { ...options, sourceId: 'other' })).id, agent(first).id);
});

test('unknown records are ignored and strings cannot create commands or executable objects', () => {
  const result = parse([
    { timestamp: end, type: 'future_record', payload: { type: 'handoff.offer' } },
    event(start, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<script>danger()</script> claim me; all tests passed' }] }),
  ]);
  assert.equal(agent(result).lastSeen, '2026-01-02T09:00:00.000Z');
  assert.match(spans(result)[0].detail, /<script>/);
  assert.deepEqual(result.commands.map((command) => command.type), ['agent.upsert', 'span.upsert']);
});

test('custom tool calls pair and explicit Claude tool errors retain the matching duration', () => {
  const custom = parse([event(start, { type: 'custom_tool_call', call_id: 'x', name: 'patch', input: 'synthetic text' }), event(end, { type: 'custom_tool_call_output', call_id: 'x', output: 'done' })]);
  assert.equal(spans(custom)[0].endedAt, '2026-01-02T09:00:05.000Z');
  const claude = parse([
    { timestamp: start, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } },
    { timestamp: end, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'failed', is_error: true }] } },
  ], 'claude');
  assert.equal(spans(claude)[0].kind, 'error');
  assert.equal(spans(claude)[0].endedAt, '2026-01-02T09:00:05.000Z');
});

test('history output is bounded while latest agent metadata and usage are retained', () => {
  const rows = Array.from({ length: 5002 }, (_, index) => event(new Date(Date.parse(start) + index * 1000).toISOString(), { type: 'message', id: `m${index}`, role: 'user', content: [{ type: 'input_text', text: `example ${index}` }] }));
  const result = parse(rows);
  assert.equal(result.commands.length, 5001);
  assert.equal(spans(result)[0].detail, 'example 2');
  assert.equal(agent(result).lastSeen, rows.at(-1).timestamp);
  assert.ok(result.warnings.some((warning) => warning.includes('5000 of 5002')));
});

test('invalid parser options fail before reading data; empty and unsupported transcripts are empty', () => {
  assert.throws(() => parseTranscript('', { provider: 'other', sourceId: 'a' }), /Provider/);
  assert.throws(() => parseTranscript('', { provider: 'codex', sourceId: '' }), /sourceId/);
  assert.deepEqual(parseTranscript('', { provider: 'codex', sourceId: 'a' }), { commands: [], warnings: [] });
  assert.deepEqual(parse([{ type: 'future' }]), { commands: [], warnings: [] });
});

test('both synthetic fixtures satisfy the reducer contract without invented outcomes', () => {
  for (const [provider, file] of [['claude', 'claude-session.jsonl'], ['codex', 'codex-rollout.jsonl']]) {
    const parsed = parseTranscript(fixture(file), { provider, sourceId: file });
    const state = applyCommands(emptyState(), parsed.commands);
    assert.deepEqual(validateSnapshot(state), state);
    assert.equal(state.runs.length + state.handoffs.length + state.attention.length, 0);
  }
});

test('ANSI and NUL in log text and metadata become visible escapes accepted by the model', () => {
  const parsed = parse([
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic\u0000session', cwd: '/sample\u001b[31m/project', timestamp: '2026-01-01T00:00:00Z' } },
    event(start, { type: 'function_call', call_id: 'x', name: 'tool\u0007', arguments: '{}' }),
    event(end, { type: 'function_call_output', call_id: 'x', output: '\u001b[31mred\u001b[0m\u0000\nline two' }),
  ]);
  const state = applyCommands(emptyState(), parsed.commands);
  assert.match(state.events[0].detail, /\\u001b\[31mred/);
  assert.match(state.events[0].detail, /\\u0000\nline two/);
  assert.equal(state.agents[0].startedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(parsed.warnings.some((warning) => warning.includes('not the raw transcript')));
});

test('fractional timestamps normalize and malformed known envelopes warn', () => {
  const result = parse([
    { type: 'response_item', timestamp: start, payload: null },
    event('2026-01-02T09:00:00.123456Z', { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Synthetic system text' }] }),
  ]);
  assert.equal(spans(result)[0].startedAt, '2026-01-02T09:00:00.123Z');
  assert.equal(spans(result)[0].label, 'System message');
  assert.ok(result.warnings.some((warning) => warning.includes('malformed transcript record')));
});

test('duplicate call IDs retain the first invocation without pairing unrelated calls', () => {
  const result = parse([
    event(start, { type: 'function_call', call_id: 'x', name: 'first', arguments: '{}' }),
    event(end, { type: 'function_call', call_id: 'x', name: 'later', arguments: '{"changed":true}' }),
  ]);
  assert.equal(spans(result).length, 1);
  assert.equal(spans(result)[0].label, 'first');
  assert.equal(spans(result)[0].endedAt, null);
  assert.ok(result.warnings.some((warning) => warning.includes('repeated tool call ID')));
});

test('untrusted role and prototype-like values remain ordinary text', () => {
  const result = parse([event(start, { type: 'message', role: '__proto__', content: [{ type: 'input_text', text: '{"__proto__":{"polluted":true}}' }] })]);
  const state = applyCommands(emptyState(), result.commands);
  assert.equal(state.events[0].label, 'Message');
  assert.equal({}.polluted, undefined);
});

const completed = (item, timing = {}) => ({
  timestamp: end, type: 'event_msg', payload: {
    type: 'item_completed', thread_id: 'synthetic-thread', turn_id: 'synthetic-turn', item,
    started_at_ms: Date.parse(start), completed_at_ms: Date.parse(end), ...timing,
  },
});

test('completed items retain reported intervals, errors, and subagent activity without legacy responses', () => {
  const result = parse([
    completed({ type: 'Reasoning', id: 'reason', summary_text: [], raw_content: [], encrypted_content: 'opaque-synthetic-data' }),
    completed({ type: 'AgentMessage', id: 'message', content: [{ type: 'Text', text: 'Fictional update' }] }),
    completed({ type: 'CommandExecution', id: 'command', command: ['example', '--check'], status: 'failed', exit_code: 2, aggregated_output: 'Fictional failure' }),
    completed({ type: 'McpToolCall', id: 'mcp', server: 'sample', tool: 'lookup', arguments: {}, status: 'completed', result: { isError: true, content: [] } }),
    completed({ type: 'SubAgentActivity', id: 'subagent', kind: 'spawn', agent_path: '/synthetic/worker' }),
    completed({ type: 'FileChange', id: 'file', status: 'completed', changes: {}, stdout: '', stderr: '' }),
    completed({ type: 'ImageView', id: 'image', path: 'fictional-image.png' }),
    completed({ type: 'ContextCompaction', id: 'compact' }),
    completed({ type: 'Extension', id: 'extension', kind: 'synthetic-extension', action: {}, results: [] }),
  ]);
  assert.equal(spans(result).length, 9);
  assert.equal(spans(result).filter((span) => span.kind === 'error').length, 2);
  assert.equal(spans(result).filter((span) => span.kind === 'subagent').length, 1);
  assert.equal(spans(result).filter((span) => span.kind === 'thinking').length, 1);
  assert.ok(spans(result).every((span) => Date.parse(span.endedAt) - Date.parse(span.startedAt) === 5000));
  assert.ok(spans(result).every((span) => !span.detail.includes('opaque-synthetic-data')));
  assert.equal(agent(result).status, 'unknown');
  assert.deepEqual(validateSnapshot(applyCommands(emptyState(), result.commands)).events.length, 9);
});

test('completed records deduplicate later responses and upgrade persisted fallback span IDs', () => {
  const fallback = [
    event(end, { type: 'reasoning', id: 'reason', summary: [{ type: 'summary_text', text: 'Synthetic summary' }] }),
    event(end, { type: 'message', id: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic response' }] }),
    event(start, { type: 'function_call', call_id: 'tool', name: 'lookup', namespace: 'sample', arguments: '{}' }),
    event(end, { type: 'function_call_output', call_id: 'tool', output: 'Synthetic result' }),
  ];
  const first = parse(fallback);
  const complete = [
    completed({ type: 'Reasoning', id: 'reason', summary_text: ['Synthetic summary'], raw_content: [] }),
    completed({ type: 'AgentMessage', id: 'message', content: [{ type: 'Text', text: 'Synthetic response' }] }),
    completed({ type: 'McpToolCall', id: 'tool', server: 'sample', tool: 'lookup', arguments: {}, status: 'failed', result: { isError: true } }),
  ];
  const updated = parse([...complete, ...fallback]);
  assert.equal(spans(updated).length, 3);
  assert.deepEqual(spans(updated).map((span) => span.id).sort(), spans(first).map((span) => span.id).sort());
  const state = applyCommands(applyCommands(emptyState(), first.commands), updated.commands);
  assert.equal(state.events.length, 3);
  assert.ok(state.events.every((span) => Date.parse(span.endedAt) - Date.parse(span.startedAt) === 5000));
  assert.equal(state.events.filter((span) => span.kind === 'error').length, 1);
  assert.deepEqual(parse([...fallback, ...complete]).commands, updated.commands);
});

test('a completion-only item keeps its identity when a matching tool response arrives later', () => {
  const item = completed({ type: 'AgentMessage', id: 'question', content: [], questions: [{ id: 'synthetic-question', question: 'Pick a fictional color' }] });
  const first = parse([item]);
  const updated = parse([item,
    event(start, { type: 'function_call', call_id: 'question', name: 'request_user_input', arguments: '{}' }),
    event(end, { type: 'function_call_output', call_id: 'question', output: 'Synthetic answer' }),
  ]);
  assert.equal(spans(first).length, 1);
  assert.equal(spans(updated).length, 1);
  assert.equal(spans(first)[0].id, spans(updated)[0].id);
});

test('invalid completed timing retains legacy pairing and warns instead of inventing an interval', () => {
  const result = parse([
    completed({ type: 'McpToolCall', id: 'tool', server: 'sample', tool: 'lookup', status: 'failed' }, { started_at_ms: Date.parse(end), completed_at_ms: Date.parse(start) }),
    event(start, { type: 'function_call', call_id: 'tool', name: 'lookup', arguments: '{}' }),
    event(end, { type: 'function_call_output', call_id: 'tool', output: 'Synthetic result' }),
    completed({ type: 'Reasoning', id: 'unknown-time', summary_text: [] }, { started_at_ms: null, completed_at_ms: 0 }),
  ]);
  assert.equal(spans(result).length, 2);
  const tool = spans(result).find((span) => span.kind === 'error');
  assert.equal(Date.parse(tool.endedAt) - Date.parse(tool.startedAt), 5000);
  const unknown = spans(result).find((span) => span.kind === 'thinking');
  assert.equal(unknown.startedAt, unknown.endedAt);
  assert.ok(result.warnings.some((warning) => /timing|duration/.test(warning)));
});

test('first child metadata owns identity and explicit ordinal excludes inherited history before sorting', () => {
  const earlier = '2026-01-01T09:00:00Z';
  const rows = [
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-thread', timestamp: start, cwd: '/fictional/child', parent_thread_id: 'synthetic-parent', forked_from_id: 'synthetic-parent', subagent_history_start_ordinal: 5 } },
    { timestamp: earlier, type: 'session_meta', payload: { id: 'synthetic-parent', timestamp: earlier, cwd: '/fictional/parent' } },
    event(earlier, { type: 'message', id: 'inherited-message', role: 'user', content: [{ type: 'input_text', text: 'Inherited fictional content' }] }),
    { timestamp: earlier, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 999 } } } },
    { timestamp: earlier, type: 'turn_context', payload: {} },
    { timestamp: start, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'synthetic-thread' } },
    completed({ type: 'Reasoning', id: 'own-reason', summary_text: ['Own fictional summary'] }),
  ];
  const result = parse(rows);
  assert.equal(agent(result).name, 'Codex synthetic-thread');
  assert.equal(agent(result).cwd, '/fictional/child');
  assert.equal(agent(result).project, 'child');
  assert.equal(agent(result).startedAt, '2026-01-02T09:00:00.000Z');
  assert.equal(agent(result).contextUsed, null);
  assert.equal(spans(result).length, 1);
  assert.ok(spans(result).every((span) => !span.detail.includes('Inherited')));
});

test('unusable history boundaries preserve first identity and retain unproven history with a warning', () => {
  for (const boundary of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    const result = parse([
      { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-thread', cwd: '/fictional/child', parent_thread_id: 'synthetic-parent', subagent_history_start_ordinal: boundary } },
      { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-parent', cwd: '/fictional/parent' } },
      event(end, { type: 'message', id: 'retained', role: 'user', content: [{ type: 'input_text', text: 'Retain this synthetic history' }] }),
    ]);
    assert.equal(agent(result).name, 'Codex synthetic-thread');
    assert.equal(agent(result).cwd, '/fictional/child');
    assert.equal(spans(result).length, 1);
    assert.ok(result.warnings.some((warning) => warning.includes('boundary')));
  }
});

test('completed user records without a stable response link are omitted, not heuristically duplicated', () => {
  const result = parse([
    completed({ type: 'UserMessage', id: 'typed-user', content: [{ type: 'Text', text: 'Synthetic user request' }] }),
    event(start, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic user request' }] }),
  ]);
  assert.equal(spans(result).length, 1);
});

test('a child log with an incomplete appended tail never reimports its inherited prefix', () => {
  const rows = [
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-thread', timestamp: start, cwd: '/fictional/child', parent_thread_id: 'synthetic-parent', subagent_history_start_ordinal: 3 } },
    '',
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-parent', timestamp: start, cwd: '/fictional/parent' } },
    event(start, { type: 'message', id: 'inherited', role: 'assistant', content: [{ type: 'output_text', text: 'Never import this inherited fixture' }] }),
    { timestamp: start, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'synthetic-thread' } },
    completed({ type: 'Reasoning', id: 'own-reason', summary_text: ['Own fixture summary'] }),
  ];
  const initial = parse(rows);
  const partial = parse([...rows, '{"timestamp":']);
  assert.deepEqual(partial.commands, initial.commands);
  const updated = applyCommands(applyCommands(emptyState(), initial.commands), partial.commands);
  assert.equal(updated.events.length, 1);
  assert.ok(updated.events.every((span) => !span.detail.includes('inherited')));
  assert.ok(partial.warnings.some((warning) => warning.includes('incomplete or malformed')));
});

test('corruption before an inherited-history boundary does not permit an unproven cut', () => {
  const result = parse([
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-thread', cwd: '/fictional/child', parent_thread_id: 'synthetic-parent', subagent_history_start_ordinal: 2 } },
    '{broken}',
    event(start, { type: 'message', id: 'retained', role: 'assistant', content: [{ type: 'output_text', text: 'Retained when record numbering is uncertain' }] }),
    completed({ type: 'Reasoning', id: 'own-reason', summary_text: [] }),
  ]);
  assert.equal(spans(result).length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes('unverified subagent history boundary')));
});

test('completion-only messages and reasoning keep their IDs after matching response append', () => {
  const items = [
    completed({ type: 'AgentMessage', id: 'message', content: [{ type: 'Text', text: 'Synthetic message' }] }),
    completed({ type: 'Reasoning', id: 'reason', summary_text: ['Synthetic summary'] }),
  ];
  const first = parse(items);
  const appended = parse([...items,
    event(end, { type: 'message', id: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic message' }] }),
    event(end, { type: 'reasoning', id: 'reason', summary: [{ type: 'summary_text', text: 'Synthetic summary' }] }),
  ]);
  const state = applyCommands(applyCommands(emptyState(), first.commands), appended.commands);
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.map((span) => span.id).sort(), spans(first).map((span) => span.id).sort());
});

test('completed errors use explicit status, exit code, or isError, never output prose', () => {
  const result = parse([
    completed({ type: 'CommandExecution', id: 'nonzero', exit_code: 7, aggregated_output: 'Done' }),
    completed({ type: 'CommandExecution', id: 'status', status: 'failed', aggregated_output: 'Done' }),
    completed({ type: 'McpToolCall', id: 'flag', result: { isError: true } }),
    completed({ type: 'McpToolCall', id: 'unknown', result: { content: [{ type: 'text', text: 'error: synthetic prose only' }] } }),
    completed({ type: 'CommandExecution', id: 'no-exit-code', status: 'unrecognized-status', aggregated_output: 'failed: synthetic prose only' }),
  ]);
  assert.equal(spans(result).filter((span) => span.kind === 'error').length, 3);
  assert.equal(spans(result).filter((span) => span.kind === 'tool').length, 2);
  assert.equal(result.commands.some((command) => command.type === 'run.upsert'), false);
});

test('invalid completed timing does not close a fallback tool with an absent result', () => {
  const result = parse([
    event(start, { type: 'function_call', call_id: 'open', name: 'lookup', arguments: '{}' }),
    completed({ type: 'McpToolCall', id: 'open', server: 'sample', tool: 'lookup' }, { started_at_ms: Date.parse(start), completed_at_ms: null }),
  ]);
  assert.equal(spans(result).length, 1);
  assert.equal(spans(result)[0].startedAt, '2026-01-02T09:00:00.000Z');
  assert.equal(spans(result)[0].endedAt, null);
});

test('a future child-history boundary defers the prefix throughout initial append and persistence', () => {
  const prefix = [
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-thread', timestamp: start, cwd: '/fictional/child', parent_thread_id: 'synthetic-parent', subagent_history_start_ordinal: 4 } },
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-parent', timestamp: start, cwd: '/fictional/parent' } },
    event(start, { type: 'message', id: 'inherited-first', role: 'assistant', content: [{ type: 'output_text', text: 'Inherited synthetic prefix' }] }),
  ];
  const initial = parse(prefix);
  assert.equal(spans(initial).length, 0);
  assert.equal(agent(initial).name, 'Codex synthetic-thread');
  assert.equal(agent(initial).cwd, '/fictional/child');
  assert.ok(initial.warnings.some((warning) => warning.includes('not yet reached')));
  const partial = parse([...prefix, '{"timestamp":']);
  assert.deepEqual(partial.commands, initial.commands);
  const appended = parse([...prefix,
    event(start, { type: 'message', id: 'inherited-second', role: 'assistant', content: [{ type: 'output_text', text: 'Another inherited synthetic record' }] }),
    { timestamp: start, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'synthetic-thread' } },
    completed({ type: 'Reasoning', id: 'own-reason', summary_text: ['Own synthetic activity'] }),
  ]);
  let state = applyCommands(emptyState(), initial.commands);
  state = applyCommands(state, partial.commands);
  state = applyCommands(state, appended.commands);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].detail, 'Own synthetic activity');
  assert.equal(state.agents[0].name, 'Codex synthetic-thread');
  assert.equal(state.agents[0].cwd, '/fictional/child');
});

test('an unreached safe boundary is pending, while an unlinked boundary remains unverified', () => {
  const rows = (linked) => [
    { timestamp: start, type: 'session_meta', payload: { id: 'synthetic-thread', cwd: '/fictional/child', ...(linked ? { parent_thread_id: 'synthetic-parent' } : {}), subagent_history_start_ordinal: 100 } },
    event(start, { type: 'message', id: 'history', role: 'user', content: [{ type: 'input_text', text: 'Synthetic history' }] }),
  ];
  const pending = parse(rows(true));
  assert.equal(spans(pending).length, 0);
  assert.ok(pending.warnings.some((warning) => warning.includes('not yet reached')));
  const unlinked = parse(rows(false));
  assert.equal(spans(unlinked).length, 1);
  assert.ok(unlinked.warnings.some((warning) => warning.includes('unverified subagent history boundary')));
});
