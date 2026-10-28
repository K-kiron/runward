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
