import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscript } from '../lib/adapters.mjs';
import { applyCommands, emptyState } from '../lib/model.mjs';
import { watchTranscripts } from '../lib/watch.mjs';

const at = second => new Date(Date.UTC(2026, 0, 2, 9, 0, second)).toISOString();
const row = (second, type, payload) => ({ timestamp: at(second), type, payload });
const lifecycle = (second, type) => row(second, 'event_msg', { type });
const question = (id = 'ask', name = 'request_user_input_async', questions = [{ title: 'Choose a color', options: ['Blue', 'Green'] }]) =>
  row(1, 'response_item', { type: 'function_call', call_id: id, name, namespace: 'functions', arguments: JSON.stringify({ questions }) });
const output = (id = 'ask', value = { accepted: true }) => row(2, 'response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify(value) });
const reply = (id = 'ask', index = 0, second = 4) => row(second, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text:
  `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', id, index]), question: 'Choose a color', answer: 'Blue' }])}</send_user_message_question_reply>\n` }] });
const parse = rows => parseTranscript(rows.map(JSON.stringify).join('\n'), { provider: 'codex', sourceId: 'synthetic-input' });
const stateOf = rows => {
  const { commands } = parse(rows);
  let state = emptyState();
  for (let index = 0; index < commands.length; index += 1000) state = applyCommands(state, commands.slice(index, index + 1000));
  return state;
};
const requests = state => state.events.filter(event => event.kind === 'attention');
const open = state => requests(state).filter(event => event.endedAt === null);

test('async acceptance and turn completion leave the question open until its correlated user reply', () => {
  const rows = [lifecycle(0, 'task_started'), question(), output(), lifecycle(3, 'task_complete')];
  const pending = stateOf(rows);
  assert.equal(open(pending).length, 1);
  assert.equal(pending.agents[0].status, 'idle');
  assert.equal(pending.events.find(event => event.label === 'functions.request_user_input_async').endedAt, at(2));
  const answered = applyCommands(pending, parse([...rows, reply()]).commands);
  assert.equal(open(answered).length, 0);
  assert.equal(requests(answered).length, 1);
  assert.equal(requests(answered)[0].id, open(pending)[0].id);
  assert.equal(requests(answered)[0].endedAt, at(4));
});

test('async replies resolve only the matched question index and request', () => {
  const rows = [lifecycle(0, 'task_started'), question('first', 'request_user_input_async', [{ title: 'First choice' }, { title: 'Second choice' }]), output('first'), question('second'), output('second')];
  const pending = stateOf([...rows, reply('first', 0)]);
  assert.equal(open(pending).length, 2);
  const partial = open(pending).find(event => event.detail.includes('Second choice'));
  assert.ok(partial);
  assert.doesNotMatch(partial.detail, /First choice/);
  assert.equal(open(stateOf([...rows, reply('first', 0), reply('first', 1, 5)])).length, 1);
  const done = stateOf([...rows, reply('first', 0), reply('first', 1, 5), reply('second', 0, 6)]);
  assert.equal(open(done).length, 0);
  assert.deepEqual(parse([...rows, reply('first', 0), reply('first', 0)]).commands, parse([...rows, reply('first', 0)]).commands);
});

test('ordinary messages, quoted reply markup, and invalid correlations cannot clear an async request', () => {
  const unrelated = row(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue with the other task.' }] });
  const quoted = structuredClone(reply());
  quoted.payload.content[0].text = `Example: ${quoted.payload.content[0].text}`;
  const assistant = structuredClone(reply()); assistant.payload.role = 'assistant';
  const pending = stateOf([question(), output(), unrelated, quoted, assistant, reply('other'), reply('ask', 99), reply('ask', -1)]);
  assert.equal(open(pending).length, 1);
});

test('blocking input waits only until its result or an explicit turn end', () => {
  const rows = [lifecycle(0, 'task_started'), question('ask', 'request_user_input')];
  assert.equal(stateOf(rows).agents[0].status, 'waiting');
  assert.equal(open(stateOf(rows)).length, 1);
  const answered = stateOf([...rows, output('ask', { answers: { color: 'Blue' } })]);
  assert.equal(open(answered).length, 0);
  assert.equal(answered.agents[0].status, 'working');
  const aborted = stateOf([...rows, lifecycle(3, 'turn_aborted')]);
  assert.equal(aborted.agents[0].status, 'idle');
  assert.equal(open(aborted).length, 0);
});

test('failed async registration and unrelated tool names do not create outstanding questions', () => {
  assert.equal(open(stateOf([question(), output('ask', { accepted: false })])).length, 0);
  assert.equal(open(stateOf([question('ask', 'custom_request_user_input_async')])).length, 0);
});

test('completed async question items converge with their later matching tool records', () => {
  const item = row(1, 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'ask', content: [], delivery: 'async', questions: [{ title: 'Choose a color', options: ['Blue', 'Green'] }] }, started_at_ms: Date.parse(at(1)), completed_at_ms: Date.parse(at(2)) });
  const pending = stateOf([item]);
  assert.equal(open(pending).length, 1);
  const updated = applyCommands(pending, parse([item, question(), output()]).commands);
  assert.equal(open(updated).length, 1);
  assert.equal(open(updated)[0].id, open(pending)[0].id);
  assert.equal(open(stateOf([item, question(), output(), reply()])).length, 0);
  const incomplete = question(); incomplete.payload.arguments = '{}';
  const twoQuestions = structuredClone(item);
  twoQuestions.payload.item.questions.push({ title: 'Choose a shape' });
  assert.equal(open(stateOf([incomplete, twoQuestions, output(), reply()])).length, 1, 'completed items supply question counts missing from legacy calls');
});

test('unresolved requests survive span retention in both parser and reducer', () => {
  const rows = [question(), output(), ...Array.from({ length: 5001 }, (_, index) => row(index + 3, 'response_item', { type: 'message', id: `note-${index}`, role: 'assistant', content: [{ type: 'output_text', text: 'Working' }] }))];
  const state = stateOf(rows);
  assert.equal(state.events.length, 5000);
  assert.equal(open(state).length, 1);
  const agentId = state.agents[0].id;
  const appended = applyCommands(state, { type: 'span.upsert', data: { id: 'later', agentId, kind: 'message', startedAt: at(6000), endedAt: at(6000) } });
  assert.equal(open(appended).length, 1);
  let answered = state;
  const { commands } = parse([...rows, reply()]);
  for (let index = 0; index < commands.length; index += 1000) answered = applyCommands(answered, commands.slice(index, index + 1000));
  assert.equal(open(answered).length, 0, 'old persisted questions must close even when their spans fall outside retained history');
});

test('watcher replay and restart keep one async request and close it when the reply is appended', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-input-'));
  const path = join(folder, 'session.jsonl');
  await writeFile(path, [lifecycle(0, 'task_started'), question(), output()].map(JSON.stringify).join('\n') + '\n');
  let state = emptyState();
  let stop;
  const errors = [];
  const start = () => watchTranscripts([{ provider: 'codex', path }], async commands => { state = applyCommands(state, commands); }, message => errors.push(message), 10);
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${errors.join('; ')}`); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  t.after(async () => { await stop?.(); await rm(folder, { recursive: true, force: true }); });
  stop = start();
  await until(() => open(state).length === 1);
  await stop();
  const revision = state.revision;
  stop = start();
  await until(() => state.revision > revision);
  assert.equal(open(state).length, 1);
  await appendFile(path, JSON.stringify(reply()) + '\n');
  await until(() => open(state).length === 0);
  assert.equal(requests(state).length, 1);
});
