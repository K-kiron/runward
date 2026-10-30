import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm, rename, mkdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchTranscripts } from '../lib/watch.mjs';
import { enrollTranscript } from '../lib/enrollment.mjs';
import { applyCommands, emptyState } from '../lib/model.mjs';
import * as zlib from 'node:zlib';

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
  const message = { timestamp: '2026-10-28T12:00:01Z', type: 'response_item', payload: { type: 'message', id: 'unrelated', role: 'assistant', content: [{ type: 'output_text', text: 'Independent note' }] } };
  const output = { timestamp: '2026-10-28T12:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'one', output: 'ok' } };
  const initial = `${JSON.stringify(call)}\n${JSON.stringify(message)}\n`;
  await writeFile(path, initial);
  let state = emptyState();
  const warnings = [];
  const batches = [];
  const stop = watchTranscripts([{ provider: 'codex', path }], async commands => { batches.push(commands); state = applyCommands(state, commands); }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => state.events.length === 2);
  assert.equal(state.events[0].endedAt, null);
  assert.equal(await readFile(path, 'utf8'), initial);
  const appended = `${JSON.stringify(output)}\n`;
  await appendFile(path, appended);
  await until(() => state.events[0].endedAt !== null);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].endedAt, '2026-10-28T12:00:03.000Z');
  assert.equal(await readFile(path, 'utf8'), initial + appended);
  assert.ok(warnings.some(warning => warning.includes('transcript warning')));
  assert.deepEqual(batches.map(batch => batch.length), [3, 2]);
  assert.deepEqual(batches[1].map(command => command.type), ['agent.upsert', 'span.upsert']);
  assert.equal(batches[1][1].data.id, state.events[0].id);
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

test('unsupported and partial appends do not dispatch unchanged records; a completed new record sends only its delta', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-watch-'));
  const path = join(folder, 'session.jsonl');
  const row = (id, timestamp) => JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: `Synthetic ${id}` }] } });
  await writeFile(path, `${row('first', '2026-10-28T12:00:00Z')}\n`);
  let state = emptyState();
  const batches = [];
  let reports = 0;
  const stop = watchTranscripts([{ provider: 'codex', path }], async commands => {
    state = applyCommands(state, commands);
    batches.push(commands);
  }, () => { reports += 1; }, 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => reports === 1);
  assert.equal(batches.length, 1);
  await appendFile(path, `${JSON.stringify({ timestamp: '2026-10-28T12:00:01Z', type: 'unsupported' })}\n`);
  await until(() => reports === 2);
  assert.equal(batches.length, 1);
  const next = row('second', '2026-10-28T12:00:02Z');
  await appendFile(path, next.slice(0, 20));
  await until(() => reports === 3);
  assert.equal(batches.length, 1);
  await appendFile(path, `${next.slice(20)}\n`);
  await until(() => reports === 4);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1].map(command => command.type), ['agent.upsert', 'span.upsert']);
  assert.equal(batches[1][0].data.lastSeen, '2026-10-28T12:00:02.000Z');
  assert.equal(batches[1][1].data.detail, 'Synthetic second');
  assert.equal(state.events.length, 2);
  assert.equal(state.revision, 2);
});

test('retry after a failed second batch does not replay acknowledged records', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-watch-'));
  const path = join(folder, 'session.jsonl');
  const rows = Array.from({ length: 1100 }, (_, index) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 28, 12, 0, index)).toISOString(), type: 'response_item', payload: { type: 'message', id: `message-${index}`, role: 'assistant', content: [{ type: 'output_text', text: `Synthetic event ${index}` }] } }));
  await writeFile(path, rows.join('\n'));
  let state = emptyState();
  const attempts = [];
  const warnings = [];
  const stop = watchTranscripts([{ provider: 'codex', path }], async commands => {
    attempts.push(commands.length);
    if (attempts.length === 2) throw new Error('Synthetic storage failure');
    state = applyCommands(state, commands);
  }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => state.events.length === 1100);
  assert.deepEqual(attempts, [1000, 101, 101]);
  assert.equal(state.revision, 2);
  assert.ok(warnings.some(warning => warning.includes('Synthetic storage failure')));
});

test('truncating an enrolled transcript pauses it until explicit reenrollment', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-watch-'));
  const path = join(folder, 'session.jsonl');
  const row = id => JSON.stringify({ timestamp: '2026-10-28T12:00:00Z', type: 'response_item', payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: `Synthetic ${id}` }] } });
  const first = row('first');
  const second = row('second');
  await writeFile(path, `${first}\n${second}\n`);
  let state = emptyState();
  const batches = [];
  const reports = [];
  const stop = watchTranscripts([{ provider: 'codex', path }], async commands => {
    state = applyCommands(state, commands);
    batches.push(commands);
  }, warning => { reports.push(warning); }, 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => reports.length === 1);
  await writeFile(path, `${second}\n`);
  await until(() => reports.some(warning => /paused.*reenroll/i.test(warning)));
  assert.equal(batches.length, 1);
  await appendFile(path, `${first}\n`);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(batches.length, 1);
  assert.equal(state.events.length, 2);
});

test('concatenated Zstandard frames import every frame and recover from a partial append', { skip: !zlib.zstdCompressSync }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-zstd-'));
  const path = join(folder, 'session.jsonl.zstd');
  const call = { timestamp: '2026-01-02T09:00:00Z', type: 'response_item', payload: { type: 'function_call', call_id: 'synthetic-call', name: 'read', arguments: '{}' } };
  const result = { timestamp: '2026-01-02T09:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'synthetic-call', output: 'fixture' } };
  const first = zlib.zstdCompressSync(Buffer.from(JSON.stringify(call) + '\n'));
  const second = zlib.zstdCompressSync(Buffer.from(JSON.stringify(result) + '\n'));
  await writeFile(path, first);
  let state = emptyState();
  const warnings = [];
  const stop = watchTranscripts([{ provider: 'codex', path }], async commands => { state = applyCommands(state, commands); }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => state.events.length === 1);
  assert.equal(state.events[0].endedAt, null);
  const revision = state.revision;
  await appendFile(path, second.subarray(0, 3));
  await until(() => warnings.some(warning => !warning.includes('transcript warning')));
  assert.equal(state.revision, revision);
  await appendFile(path, second.subarray(3));
  await until(() => state.events[0].endedAt !== null);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].endedAt, '2026-01-02T09:00:05.000Z');
  assert.deepEqual(await readFile(path), Buffer.concat([first, second]));
});

test('compressed inputs cannot bypass the uncompressed size limit', { skip: !zlib.zstdCompressSync }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-zstd-limit-'));
  const path = join(folder, 'session.jsonl.zstd');
  await writeFile(path, zlib.zstdCompressSync(Buffer.alloc(32 * 1024 * 1024 + 1, 32)));
  const errors = [];
  let writes = 0;
  const stop = watchTranscripts([{ provider: 'dsh', path }], async () => { writes++; }, error => errors.push(error), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => errors.length > 0);
  assert.equal(writes, 0);
});

test('Windows UTF-16 redirected exports import without changing their source encoding', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-utf16-'));
  const path = join(folder, 'session.json');
  const recording = { sessionId: 'synthetic-session', startTime: '2026-01-02T09:00:00Z', messages: [
    { id: 'synthetic-message', type: 'user', timestamp: '2026-01-02T09:00:00Z', content: 'Fictional café 示例' },
  ] };
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(recording), 'utf16le')]);
  await writeFile(path, bytes);
  let state = emptyState();
  const stop = watchTranscripts([{ provider: 'gemini', path }], async commands => { state = applyCommands(state, commands); }, () => {}, 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => state.events.length === 1);
  assert.equal(state.events[0].detail, 'Fictional café 示例');
  assert.deepEqual(await readFile(path), bytes);
});

test('replacement between enrollment and the first poll is rejected before dispatch', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-enrollment-'));
  const path = join(folder, 'session.jsonl');
  const row = JSON.stringify({ timestamp: '2026-01-02T09:00:00Z', type: 'response_item', payload: { type: 'message', id: 'one', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic original' }] } });
  await writeFile(path, row);
  const source = await enrollTranscript({ id: 'selected', generation: 1, provider: 'codex', path });
  assert.equal(typeof source.fileIdentity.ino, 'string');
  await rename(path, join(folder, 'original.jsonl'));
  await writeFile(path, row.replace('original', 'replaced'));
  const warnings = [];
  let writes = 0;
  const stop = watchTranscripts([source], async () => { writes++; }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => warnings.length > 0);
  assert.match(warnings[0], /paused.*reenroll/i);
  assert.equal(writes, 0);
});

test('a revoked source stops retrying callbacks while other selected sources still import', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-revoked-watch-'));
  const row = JSON.stringify({ timestamp: '2026-01-02T09:00:00Z', type: 'response_item', payload: { type: 'message', id: 'one', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic' }] } });
  await writeFile(join(folder, 'revoked.jsonl'), row);
  await writeFile(join(folder, 'active.jsonl'), row);
  const warnings = [];
  const calls = [];
  const stop = watchTranscripts(['revoked', 'active'].map(id => ({ id, generation: 1, provider: 'codex', path: join(folder, `${id}.jsonl`) })), async (commands, source) => {
    calls.push(source.id);
    if (source.id === 'revoked') throw Object.assign(new Error('Source is revoked'), { code: 'SOURCE_REVOKED' });
  }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => calls.includes('active'));
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(calls, ['revoked', 'active']);
});

test('retargeting a selected directory junction never imports its new destination', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-link-watch-'));
  const first = join(folder, 'first');
  const second = join(folder, 'second');
  const link = join(folder, 'selected');
  await mkdir(first); await mkdir(second);
  const row = text => JSON.stringify({ timestamp: '2026-01-02T09:00:00Z', type: 'response_item', payload: { type: 'message', id: 'one', role: 'assistant', content: [{ type: 'output_text', text }] } });
  await writeFile(join(first, 'session.jsonl'), row('Original synthetic source'));
  await writeFile(join(second, 'session.jsonl'), row('Different synthetic source'));
  try { await symlink(first, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    await rm(folder, { recursive: true, force: true });
    if (error.code === 'EPERM') return t.skip('Directory links are unavailable on this platform');
    throw error;
  }
  const source = await enrollTranscript({ id: 'selected', generation: 1, provider: 'codex', path: join(link, 'session.jsonl') });
  const calls = [];
  const warnings = [];
  const stop = watchTranscripts([source], async commands => calls.push(commands), warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => calls.length === 1);
  await unlink(link);
  await symlink(second, link, process.platform === 'win32' ? 'junction' : 'dir');
  await until(() => warnings.some(warning => /paused.*reenroll/i.test(warning)));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].find(command => command.type === 'span.upsert').data.detail, 'Original synthetic source');
});

test('same-inode rewrites pause even when the transcript did not shrink', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-rewrite-watch-'));
  const path = join(folder, 'session.jsonl');
  const row = JSON.stringify({ timestamp: '2026-01-02T09:00:00Z', type: 'response_item', payload: { type: 'message', id: 'one', role: 'assistant', content: [{ type: 'output_text', text: 'Original' }] } });
  await writeFile(path, row);
  const warnings = [];
  let writes = 0;
  const stop = watchTranscripts([{ provider: 'codex', path }], async () => { writes++; }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => writes === 1);
  await writeFile(path, row.replace('Original', 'Modified'));
  await until(() => warnings.some(warning => /paused.*reenroll/i.test(warning)));
  assert.equal(writes, 1);
});

test('replacing an enrolled file with a directory remains paused after restoring it', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-type-watch-'));
  const path = join(folder, 'session.jsonl');
  const original = join(folder, 'original.jsonl');
  const row = JSON.stringify({ timestamp: '2026-01-02T09:00:00Z', type: 'response_item', payload: { type: 'message', id: 'one', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic' }] } });
  await writeFile(path, row);
  const warnings = [];
  let writes = 0;
  const stop = watchTranscripts([{ provider: 'codex', path }], async () => { writes++; }, warning => warnings.push(warning), 10);
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => writes === 1);
  await rename(path, original);
  await mkdir(path);
  await until(() => warnings.some(warning => /paused.*reenroll/i.test(warning)));
  await rm(path, { recursive: true });
  await rename(original, path);
  await appendFile(path, `${row}\n`);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(writes, 1);
});
