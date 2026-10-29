import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../lib/adapters.mjs';
import { applyCommands, emptyState, validateSnapshot } from '../lib/model.mjs';

const start = '2026-01-02T09:00:00Z';
const end = '2026-01-02T09:00:05Z';
const meta = { sessionId: 'synthetic-gemini', projectHash: 'fictional-hash', startTime: start, lastUpdated: end, directories: ['/fictional/garden'] };
const message = (id, content = 'Fictional text') => ({ id, type: 'gemini', timestamp: end, content });
const parse = rows => parseTranscript(typeof rows === 'string' ? rows : rows.map(JSON.stringify).join('\n'), { provider: 'gemini', sourceId: 'synthetic-source' });
const spans = result => result.commands.filter(command => command.type === 'span.upsert').map(command => command.data);

test('Gemini JSONL folds message updates and preserves scoped tools, thought summaries, and explicit errors', () => {
  const pending = { id: 'same-call', name: 'read_file', timestamp: start, status: 'executing', args: { path: 'fictional.txt' } };
  const result = parse([meta, { ...message('one', ''), toolCalls: [pending] },
    { ...message('one'), thoughts: [{ subject: 'Inspect', description: 'Fictional summary', timestamp: start }], toolCalls: [{ ...pending, timestamp: end, status: 'error', result: 'Synthetic error' }] },
    { ...message('two', ''), toolCalls: [{ ...pending, status: 'success', timestamp: end }] },
  ]);
  assert.equal(result.commands[0].data.provider, 'Gemini CLI');
  assert.equal(result.commands[0].data.cwd, '/fictional/garden');
  assert.equal(result.commands[0].data.status, 'unknown');
  assert.equal(result.commands[0].data.contextUsed, null);
  assert.equal(spans(result).length, 4);
  const failed = spans(result).find(span => span.kind === 'error');
  assert.equal(Date.parse(failed.endedAt) - Date.parse(failed.startedAt), 5000);
  assert.equal(spans(result).filter(span => span.label === 'read_file').length, 2);
  assert.equal(spans(result).find(span => span.kind === 'thinking').startedAt, '2026-01-02T09:00:00.000Z');
  validateSnapshot(applyCommands(emptyState(), result.commands));
});

test('Gemini legacy JSON snapshot imports without inventing tool duration or task success', () => {
  const result = parse(JSON.stringify({ ...meta, messages: [{ ...message('one'), toolCalls: [{ id: 'call', name: 'read', timestamp: end, status: 'success', result: 'ok' }], tokens: { input: 10, total: 500 } }] }, null, 2));
  assert.equal(spans(result).length, 2);
  assert.ok(spans(result).every(span => span.startedAt === span.endedAt));
  assert.equal(result.commands.some(command => command.type === 'run.upsert'), false);
  assert.equal(result.commands[0].data.contextUsed, null);
});

test('Gemini patch updates content and known tool results without mutating the source', () => {
  const rows = [meta, { ...message('one'), toolCalls: [{ id: 'call', timestamp: start, name: 'read', status: 'executing' }] },
    { $patch: { updates: [{ id: 'one', content: [{ text: 'Updated fixture' }], toolCalls: [{ id: 'call', result: [{ text: 'Fixture result' }] }] }] } },
    { $set: { lastUpdated: '2026-01-02T09:01:00Z' } },
  ];
  const before = JSON.stringify(rows);
  const result = parse(rows);
  assert.equal(spans(result).find(span => span.kind === 'message').detail, 'Updated fixture');
  assert.match(spans(result).find(span => span.kind === 'tool').detail, /Fixture result/);
  assert.equal(spans(result).find(span => span.kind === 'tool').endedAt, null);
  assert.equal(result.commands[0].data.lastSeen, '2026-01-02T09:01:00.000Z');
  assert.equal(JSON.stringify(rows), before);
});

test('Gemini order patches, removals, rewind, and full-history checkpoints follow append order', () => {
  const reordered = parse([meta, message('one'), message('two'), message('three'),
    { $patch: { orderIds: ['three', 'two', 'one'] } }, { $rewindTo: 'two' },
  ]);
  assert.equal(spans(reordered).length, 1);
  const checkpoint = parse([meta, message('old'), { $set: { messages: [message('one'), message('two')] } }, { $patch: { removeIds: ['one'] } }]);
  assert.equal(spans(checkpoint).length, 1);
  assert.equal(spans(parse([meta, message('one'), { $rewindTo: 'missing' }])).length, 0);
});

test('Gemini partial tails do not duplicate history and malformed structures remain harmless', () => {
  const first = parse([meta, message('one')]);
  const partial = parse([meta, message('one'), '{"id":']);
  assert.deepEqual(partial.commands, first.commands);
  assert.ok(partial.warnings.length);
  const updated = applyCommands(applyCommands(emptyState(), first.commands), partial.commands);
  assert.equal(updated.events.length, 1);
  assert.doesNotThrow(() => parse([null, false, [], { $patch: { updates: [null], removeIds: [null], toolCalls: [null] } },
    { ...message('one'), toolCalls: [null], thoughts: [null] }]));
});

test('Gemini mixed sessions and invalid timestamps cannot contaminate a source', () => {
  assert.equal(parse([meta, message('one'), { ...meta, sessionId: 'different-fixture' }]).commands.length, 0);
  const result = parse([{ ...message('one'), timestamp: '2026-02-30T10:00:00Z' }]);
  assert.equal(result.commands.length, 0);
  assert.ok(result.warnings.length);
});

test('Gemini accepts each text-bearing PartListUnion shape without rendering binary data', () => {
  for (const content of ['Synthetic text', { text: 'Synthetic text' }, ['Synthetic text'], [{ text: 'Synthetic text' }]]) {
    const result = parse([meta, message('one', content)]);
    assert.equal(spans(result).length, 1);
    assert.equal(spans(result)[0].detail, 'Synthetic text');
  }
  assert.equal(spans(parse([meta, message('one', { inlineData: { data: 'synthetic-binary', mimeType: 'image/png' } })])).length, 0);
});
