import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchTranscripts } from '../lib/watch.mjs';
import { applyCommands, emptyState } from '../lib/model.mjs';

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transcript import');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('watching a selected transcript imports and closes tools without editing the source', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-watch-'));
  const path = join(folder, 'session.jsonl');
  const call = { timestamp: '2026-10-28T12:00:00Z', type: 'response_item', payload: { type: 'function_call', call_id: 'one', name: 'check', arguments: '{}' } };
  const output = { timestamp: '2026-10-28T12:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'one', output: 'ok' } };
  const initial = `${JSON.stringify(call)}\n`;
  await writeFile(path, initial);
  let state = emptyState();
  const warnings = [];
  const stop = watchTranscripts([{ provider: 'codex', path }], async commands => { state = applyCommands(state, commands); }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => state.events.length === 1);
  assert.equal(state.events[0].endedAt, null);
  assert.equal(await readFile(path, 'utf8'), initial);
  const appended = `${JSON.stringify(output)}\n`;
  await appendFile(path, appended);
  await until(() => state.events[0].endedAt !== null);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].endedAt, '2026-10-28T12:00:03.000Z');
  assert.equal(await readFile(path, 'utf8'), initial + appended);
  assert.ok(warnings.some(warning => warning.includes('transcript warning')));
});

test('large transcript imports respect the reducer batch limit and retain metadata', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-watch-'));
  const path = join(folder, 'session.jsonl');
  const rows = Array.from({ length: 1100 }, (_, index) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 28, 12, 0, index)).toISOString(), type: 'response_item', payload: { type: 'message', id: `message-${index}`, role: 'assistant', content: [{ type: 'output_text', text: `Synthetic event ${index}` }] } }));
  await writeFile(path, rows.join('\n'));
  let state = emptyState();
  const sizes = [];
  const stop = watchTranscripts([{ provider: 'codex', path }], async commands => { sizes.push(commands.length); state = applyCommands(state, commands); }, () => {}, 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => state.events.length === 1100);
  assert.deepEqual(sizes, [1000, 101]);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].status, 'unknown');
});
