import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, commandsForLog } from '../lib/desktop/collector.mjs';
import { createServer } from '../server.mjs';

const at = second => new Date(Date.UTC(2026, 0, 2, 9, 0, second)).toISOString();
const row = (second, type, payload) => ({ timestamp: at(second), type, payload });
const question = (id = 'ask', questions = [{ title: 'Choose a color', options: ['Blue', 'Green'] }]) =>
  row(1, 'response_item', { type: 'function_call', call_id: id, name: 'request_user_input_async',
    namespace: 'functions', arguments: JSON.stringify({ questions }) });
const accepted = (id = 'ask') => row(2, 'response_item', {
  type: 'function_call_output', call_id: id, output: JSON.stringify({ accepted: true }),
});
const reply = (id = 'ask', index = 0, second = 4) => row(second, 'response_item', {
  type: 'message', role: 'user', content: [{ type: 'input_text', text:
    `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', id, index]),
      question: 'Choose a color', answer: 'Blue' }])}</send_user_message_question_reply>\n` }],
});
const messages = (count, offset = 10) => Array.from({ length: count }, (_, index) => row(offset + index, 'response_item', {
  type: 'message', id: `note-${offset + index}`, role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic progress' }],
}));
const encode = rows => rows.map(JSON.stringify).join('\n') + '\n';
const open = app => app.snapshot().attention.filter(item => item.sourceEventId);
const requests = app => app.snapshot().events.filter(item => item.kind === 'attention');

async function fixture(t, rows, wrap = app => app) {
  const directory = await mkdtemp(join(tmpdir(), 'runward-desktop-attention-'));
  const path = join(directory, 'synthetic.jsonl');
  await writeFile(path, encode(rows));
  const app = await createServer({ domain: { id: 'synthetic', environmentId: 'test' },
    sources: [{ id: 'desktop-codex', provider: 'codex', toolInstanceId: 'synthetic', generation: 1 }] });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const collector = createCollector({ config: { codexTranscript: path, eventsPerSession: 100 }, app: wrap(app) });
  const poll = async () => {
    await collector.poll();
    assert.equal(collector.status().files[0].error, null, 'collector imports the synthetic transcript successfully');
  };
  return { app, collector, poll, append: rows => appendFile(path, encode(rows)) };
}

test('desktop discovery imports an unresolved input request older than the preview limit', async t => {
  const { app, poll, append } = await fixture(t, [question(), accepted(), ...messages(102)]);
  await poll();
  assert.equal(open(app).length, 1);
  const requestId = open(app)[0].sourceEventId;
  assert.equal(app.snapshot().events.filter(item => item.kind !== 'attention').length, 100,
    'ordinary history remains bounded independently of outstanding requests');
  const revision = app.snapshot().revision;
  await poll();
  assert.equal(app.snapshot().revision, revision, 'unchanged polls do not write duplicates');
  await append(messages(1, 200));
  await poll();
  assert.deepEqual(open(app).map(item => item.sourceEventId), [requestId]);
  await append([reply('ask', 0, 201)]);
  await poll();
  assert.equal(open(app).length, 0);
  assert.equal(requests(app).find(item => item.id === requestId).endedAt, at(201));
});

for (const count of [102, 5000]) {
  test(`desktop closes a previously imported request after its answer leaves ${count} later messages`, async t => {
    const { app, poll, append } = await fixture(t, [question(), accepted()]);
    await poll();
    assert.equal(open(app).length, 1);
    const requestId = open(app)[0].sourceEventId;
    await append([reply(), ...messages(count)]);
    await poll();
    assert.equal(open(app).length, 0, 'an old closure must update the already imported attention span');
    assert.equal(requests(app).find(item => item.id === requestId).endedAt, at(4));
    const revision = app.snapshot().revision;
    await poll();
    assert.equal(app.snapshot().revision, revision);
    await append(messages(1, count + 100));
    await poll();
    assert.equal(open(app).length, 0, 'subsequent replay must not reopen a resolved request');
  });
}

test('desktop retains multiple requests and partial answers across the preview limit', async t => {
  const { app, poll, append } = await fixture(t, [
    question('first', [{ title: 'First choice' }, { title: 'Second choice' }]), accepted('first'),
    question('second'), accepted('second'),
  ]);
  await poll();
  assert.equal(open(app).length, 2);
  await append([reply('first', 0), ...messages(102)]);
  await poll();
  assert.equal(open(app).length, 2);
  const partial = open(app).find(item => item.detail.includes('Second choice'));
  assert.ok(partial, 'partly answered requests remain visible');
  assert.doesNotMatch(partial.detail, /First choice/);
  await append([reply('first', 1, 200), ...messages(102, 201)]);
  await poll();
  assert.equal(open(app).length, 1);
  assert.equal(requests(app).find(item => item.id === partial.sourceEventId).endedAt, at(200));
  await append([reply('second', 0, 400), ...messages(102, 401)]);
  await poll();
  assert.equal(open(app).length, 0);
});

test('desktop preview limits ordinary spans while preserving pending attention', () => {
  const parsed = commandsForLog(encode([question('first'), accepted('first'), question('second'), accepted('second'),
    ...messages(102)]), { provider: 'codex', path: 'synthetic' }, [], { eventsPerSession: 100 });
  const spans = parsed.commands.filter(item => item.type === 'span.upsert');
  assert.equal(spans.filter(item => item.data.kind !== 'attention').length, 100);
  assert.equal(spans.filter(item => item.data.kind === 'attention' && item.data.endedAt === null).length, 2);
});

test('desktop imports outstanding requests beyond a single source batch without losing closures', async t => {
  const count = 1001;
  const { app, poll, append } = await fixture(t, Array.from({ length: count }, (_, index) => [
    question(`ask-${index}`), accepted(`ask-${index}`),
  ]).flat());
  await poll();
  assert.equal(open(app).length, count);
  await append(Array.from({ length: count }, (_, index) => reply(`ask-${index}`)));
  await poll();
  assert.equal(open(app).length, 0);
  assert.equal(requests(app).length, count);
  const revision = app.snapshot().revision;
  await poll();
  assert.equal(app.snapshot().revision, revision);
});

for (const phase of ['opening', 'closing']) {
  test(`desktop retries a temporary second-batch failure while ${phase} requests`, async t => {
    const count = 1001;
    const attempts = [];
    let failAt = phase === 'opening' ? 2 : Infinity;
    const { app, collector, poll, append } = await fixture(t, Array.from({ length: count }, (_, index) => [
      question(`ask-${index}`), accepted(`ask-${index}`),
    ]).flat(), app => ({ dispatchSource: async (key, commands) => {
      assert.ok(commands.length <= 1000, 'each source batch respects the server command limit');
      const attempt = { commands, succeeded: false };
      attempts.push(attempt);
      if (attempts.length === failAt) throw Object.assign(new Error('Synthetic temporary delivery failure'), { code: 'SYNTHETIC_RETRY' });
      const result = await app.dispatchSource(key, commands);
      attempt.succeeded = true;
      return result;
    } }));
    if (phase === 'closing') {
      await poll();
      assert.equal(open(app).length, count);
      await append(Array.from({ length: count }, (_, index) => reply(`ask-${index}`)));
      failAt = attempts.length + 2;
    }
    const start = attempts.length;
    await collector.poll();
    assert.equal(collector.status().files[0].error, 'SYNTHETIC_RETRY');
    assert.equal(collector.status().files[0].paused, false, 'temporary delivery failures remain retryable');
    assert.equal(attempts.length, start + 2);
    assert.equal(attempts[start].succeeded, true);
    assert.equal(attempts[start + 1].succeeded, false);
    const delivered = new Set(attempts[start].commands.map(command => `${command.type}:${command.data.id}`));
    if (phase === 'closing') assert.ok(open(app).length > 0 && open(app).length < count,
      'the first closure batch commits before the temporary failure');
    await poll();
    const retried = attempts.slice(start + 2);
    assert.ok(retried.length > 0);
    assert.ok(retried.every(attempt => attempt.succeeded));
    assert.ok(retried.flatMap(attempt => attempt.commands).every(command => !delivered.has(`${command.type}:${command.data.id}`)),
      'successfully committed commands from the first batch are not dispatched again');
    if (phase === 'opening') {
      assert.equal(open(app).length, count);
      await append(Array.from({ length: count }, (_, index) => reply(`ask-${index}`)));
      await poll();
    }
    assert.equal(open(app).length, 0);
    assert.equal(requests(app).length, count);
    const revision = app.snapshot().revision;
    const attemptCount = attempts.length;
    await poll();
    assert.equal(app.snapshot().revision, revision);
    assert.equal(attempts.length, attemptCount, 'unchanged polls do not retry already closed requests');
    await append(messages(1, 100));
    await poll();
    assert.equal(open(app).length, 0, 'later replay cannot reopen the successfully closed requests');
  });
}
