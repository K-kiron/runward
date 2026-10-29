import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../lib/adapters.mjs';
import { applyCommands, emptyState } from '../lib/model.mjs';

const start = '2026-01-02T09:00:00Z';
const end = '2026-01-02T09:00:05Z';
const event = (kind, id, fields = {}, timestamp = start) => ({ kind, id, source: 'agent', timestamp, ...fields });
const action = (id = 'action-one', tool_call_id = 'call-one') => event('ActionEvent', id, { tool_call_id, tool_name: 'terminal', thought: [{ type: 'text', text: 'Inspect the synthetic example.' }], action: { kind: 'TerminalAction', command: 'example --check' } });
const result = (fields = {}) => event('ObservationEvent', 'result-one', { action_id: 'action-one', tool_call_id: 'call-one', tool_name: 'terminal', observation: { kind: 'TerminalObservation', is_error: false, exit_code: 0, content: [{ type: 'text', text: 'Synthetic output' }] }, ...fields }, end);
const parse = rows => parseTranscript(typeof rows === 'string' ? rows : rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'), { provider: 'openhands', sourceId: 'synthetic-openhands' });
const spans = parsed => parsed.commands.filter(command => command.type === 'span.upsert').map(command => command.data);
const agent = parsed => parsed.commands.find(command => command.type === 'agent.upsert')?.data;

test('OpenHands SDK actions and observations pair by stable IDs in either file order', () => {
  const parsed = parse([result(), action()]);
  const tool = spans(parsed).find(span => span.kind === 'tool');
  assert.equal(tool.startedAt, '2026-01-02T09:00:00.000Z');
  assert.equal(tool.endedAt, '2026-01-02T09:00:05.000Z');
  assert.match(tool.detail, /example --check/);
  assert.match(tool.detail, /Synthetic output/);
  assert.equal(spans(parsed).find(span => span.kind === 'thinking').startedAt, '2026-01-02T09:00:00.000Z');
  assert.equal(agent(parsed).status, 'unknown');
  assert.deepEqual(parse([action(), result()]).commands, parsed.commands);
  assert.deepEqual(parse([action(), result(), action()]).commands, parsed.commands);
  assert.doesNotThrow(() => applyCommands(emptyState(), parsed.commands));
});

test('OpenHands supports native single-event JSON and JSON arrays without inventing runs', () => {
  const message = event('MessageEvent', 'message', { source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: 'A fictional request' }] } });
  assert.equal(spans(parse(JSON.stringify(message, null, 2)))[0].detail, 'A fictional request');
  assert.equal(spans(parse(JSON.stringify([message, action(), result()], null, 2))).length, 3);
  assert.ok(parse([message, action(), result()]).commands.every(command => ['agent.upsert', 'span.upsert'].includes(command.type)));
});

test('OpenHands keeps observation-first and action-first identities when the missing counterpart arrives', () => {
  for (const initialRows of [[action()], [result()]]) {
    const initial = parse(initialRows);
    const final = parse([...initialRows, action(), result()]);
    const initialTool = spans(initial).find(span => ['tool', 'error'].includes(span.kind));
    const finalTool = spans(final).find(span => ['tool', 'error'].includes(span.kind));
    assert.equal(initialTool.id, finalTool.id);
    assert.equal(finalTool.endedAt, '2026-01-02T09:00:05.000Z');
    const state = applyCommands(applyCommands(emptyState(), initial.commands), final.commands);
    assert.equal(state.events.filter(span => span.kind === 'tool').length, 1);
  }
});

test('OpenHands never pairs conflicting action IDs or backward observations', () => {
  const conflicting = parse([action(), result({ action_id: 'different-action' })]);
  assert.equal(spans(conflicting).find(span => span.kind === 'tool').endedAt, null);
  assert.ok(conflicting.warnings.some(warning => warning.includes('does not match')));
  const backwards = parse([action(), { ...result(), timestamp: '2026-01-02T08:59:59Z' }]);
  assert.equal(spans(backwards).find(span => span.kind === 'tool').endedAt, null);
  assert.ok(backwards.warnings.some(warning => warning.includes('predates')));
});

test('OpenHands retains explicit errors and rejects prose or soft timeout as proof of failure', () => {
  for (const observation of [{ kind: 'TerminalObservation', exit_code: 3 }, { kind: 'Observation', is_error: true }]) {
    assert.equal(spans(parse([action(), result({ observation })])).find(span => span.id && span.kind !== 'thinking').kind, 'error');
  }
  for (const observation of [{ kind: 'TerminalObservation', exit_code: -1, timeout: true }, { kind: 'Observation', content: [{ text: 'error: this is just synthetic prose' }] }]) {
    assert.equal(spans(parse([action(), result({ observation })])).find(span => span.kind !== 'thinking').kind, 'tool');
  }
  for (const kind of ['AgentErrorEvent', 'UserRejectObservation']) {
    const failure = event(kind, 'failure', { tool_call_id: 'call-one', tool_name: 'terminal', error: 'Synthetic validation error', rejection_reason: 'Synthetic rejection', action_id: 'action-one' }, end);
    assert.equal(spans(parse([action(), failure])).find(span => span.kind === 'error').endedAt, '2026-01-02T09:00:05.000Z');
  }
});

test('OpenHands explicit state updates expose safe session metadata without configuration secrets', () => {
  const state = event('ConversationStateUpdateEvent', 'state', { key: 'full_state', value: { id: 'synthetic-session', workspace: { kind: 'LocalWorkspace', working_dir: '/fictional/orchard' }, execution_status: 'running', agent: { api_key: 'synthetic-never-render-this' } } });
  const initial = parse([state]);
  assert.equal(agent(initial).name, 'OpenHands synthetic-session');
  assert.equal(agent(initial).project, 'orchard');
  assert.equal(agent(initial).status, 'working');
  assert.equal(JSON.stringify(initial.commands).includes('synthetic-never-render-this'), false);
  const waiting = event('ConversationStateUpdateEvent', 'wait', { key: 'execution_status', value: 'waiting_for_confirmation' }, end);
  assert.equal(agent(parse([state, waiting])).status, 'waiting');
  assert.equal(agent(parse([state, { ...waiting, value: undefined, key: 'execution_status', kind: 'ConversationStateUpdateEvent' }])).status, 'working');
  assert.equal(agent(parse([state, { ...waiting, value: 'new-unknown-status' }])).status, 'unknown');
});

test('OpenHands requires timezone-bearing timestamps or an explicit capture observation', () => {
  const naive = { ...action(), timestamp: '2026-01-02T09:00:00' };
  const skipped = parse([naive]);
  assert.equal(skipped.commands.length, 0);
  assert.ok(skipped.warnings.some(warning => warning.includes('timezone')));
  const captured = parse([{ ...naive, runwardObservedAt: start }, { ...result(), timestamp: '2026-01-02T09:00:05', runwardObservedAt: end }]);
  assert.equal(spans(captured).find(span => span.kind === 'tool').endedAt, '2026-01-02T09:00:05.000Z');
  assert.ok(captured.warnings.some(warning => warning.includes('capture observation')));
  const upstream = parse([{ ...action(), runwardObservedAt: end }]);
  assert.equal(spans(upstream).find(span => span.kind === 'tool').startedAt, '2026-01-02T09:00:00.000Z');
  assert.equal(upstream.warnings.some(warning => warning.includes('capture observation')), false);
});

test('OpenHands tolerates malformed rows and partial tails without executing or decoding content', () => {
  const safe = event('MessageEvent', 'text', { llm_message: { content: [{ type: 'text', text: '<script>not executed</script>\u001b[31m' }], reasoning_content: 'Visible summary', encrypted_content: 'synthetic-ciphertext' } });
  const initial = parse([safe, action()]);
  const appended = parse([safe, '{bad}', null, action(), '{"kind":']);
  assert.deepEqual(appended.commands, initial.commands);
  assert.ok(appended.warnings.length > 1);
  assert.equal(JSON.stringify(appended.commands).includes('synthetic-ciphertext'), false);
  assert.doesNotThrow(() => applyCommands(emptyState(), appended.commands));
});
