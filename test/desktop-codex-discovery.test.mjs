import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverCodex } from '../lib/desktop/codex-discovery.mjs';

const scope = 'C:/scope/Workspace';
const now = Date.parse('2026-11-07T18:00:00Z');
const iso = age => new Date(now - age * 3_600_000).toISOString();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'codex-discovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sessionsRoot = path.join(base, 'sessions');
  await mkdir(sessionsRoot);
  const indexPath = path.join(base, 'session_index.jsonl');
  const options = { sessionsRoot, indexPath, scopeRoots: [scope], now };
  const log = async (n, { cwd = scope, age = 0, date = '2026/11/07', metadata = {}, body, header } = {}) => {
    const directory = path.join(sessionsRoot, ...date.split('/'));
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-11-07T12-00-00-${id(n)}.jsonl`);
    const row = header ?? { timestamp: iso(48), type: 'session_meta', payload: { id: id(n), cwd, source: 'vscode', ...metadata } };
    await writeFile(file, `${typeof row === 'string' ? row : JSON.stringify(row)}\n${body ?? `${JSON.stringify({ timestamp: iso(age), type: 'event_msg', payload: { type: 'task_started' } })}\n`}`);
    await utimes(file, new Date(now), new Date(now));
    return file;
  };
  return { base, sessionsRoot, indexPath, options, log };
}

test('two main sessions remain distinct; child agents and out-of-scope sessions are excluded', async t => {
  const { options, log, indexPath } = await fixture(t);
  const first = await log(1);
  const second = await log(2, { cwd: `${scope}/runward`, age: 1 });
  await log(3, { metadata: { parent_thread_id: id(1) } });
  await log(4, { metadata: { forked_from_id: id(1) } });
  await log(5, { metadata: { source: { subagent: { thread_spawn: { parent_thread_id: id(1) } } } } });
  await log(6, { cwd: `${scope}Other` });
  await log(7, { cwd: `${scope}/../Other` });
  await log(8, { cwd: 'relative/path' });
  await writeFile(indexPath, [
    { id: id(1), updated_at: iso(2), thread_name: 'Old name' },
    { id: id(1), updated_at: iso(0), thread_name: '  First\n window ' },
    { id: id(2), updated_at: iso(1), thread_name: 'Second window' },
  ].map(JSON.stringify).join('\n'));
  const result = await discoverCodex(options);
  assert.deepEqual(result.files.map(file => [file.path, file.sessionId, file.title]), [
    [first, id(1), 'First window'], [second, id(2), 'Second window'],
  ]);
  assert.equal(result.stats.subagents, 3);
  assert.equal(result.stats.outOfScope, 3);
  assert.deepEqual(result.roots, [scope]);
  assert.deepEqual((await discoverCodex(options)).files.map(file => [file.path, file.sessionId]), [
    [first, id(1)], [second, id(2)],
  ]);
});

test('later sessions are discovered and fresh events survive stale Windows mtimes and old directories', async t => {
  const { options, log, indexPath } = await fixture(t);
  const first = await log(1, { age: 48, date: '2025/01/02' });
  await utimes(first, new Date(now - 72 * 3_600_000), new Date(now - 72 * 3_600_000));
  assert.equal((await discoverCodex(options)).files.length, 0);
  await appendFile(first, `${JSON.stringify({ timestamp: iso(0), type: 'event_msg' })}\n{unfinished`);
  await utimes(first, new Date(now - 72 * 3_600_000), new Date(now - 72 * 3_600_000));
  const updated = await discoverCodex(options);
  assert.equal(updated.files.length, 1);
  assert.equal(updated.files[0].sessionId, id(1));
  assert.equal(updated.files[0].latestActivityAt, iso(0));
  assert.ok(updated.files[0].mtimeMs < now - 24 * 3_600_000);
  await log(2, { date: '2026/11/08' });
  assert.equal((await discoverCodex(options)).files.length, 2);
  // The index can establish freshness even when the bounded tail contains a huge record.
  const indexed = await log(3, { age: 48, body: 'x'.repeat(80 * 1024) });
  await utimes(indexed, new Date(0), new Date(0));
  await writeFile(indexPath, `${JSON.stringify({ id: id(3), updated_at: iso(0), thread_name: 'Indexed window' })}\n`);
  const found = (await discoverCodex(options)).files.find(file => file.sessionId === id(3));
  assert.equal(found.title, 'Indexed window');
  assert.equal(found.latestActivityAt, iso(0));
});

test('only expected date depth and regular files are considered; malformed and oversized headers are bounded', async t => {
  const { base, sessionsRoot, options, log } = await fixture(t);
  await log(1);
  await log(2, { header: '{invalid JSON' });
  await log(3, { header: { type: 'event_msg', payload: { id: id(3), cwd: scope } } });
  await log(4, { header: { type: 'session_meta', payload: { cwd: scope } } });
  await log(5, { header: 'x'.repeat(100 * 1024) });
  await log(12, { metadata: { id: id(99) } });
  await log(6, { date: '2026/13/07' });
  await log(7, { date: '2026/11/40' });
  await log(8, { date: '2026/11/07/nested' });
  await writeFile(path.join(sessionsRoot, `rollout-${id(9)}.jsonl`), '{}\n');
  await mkdir(path.join(sessionsRoot, '2026', '11', '07', `rollout-${id(10)}.jsonl`));
  const external = path.join(base, 'external');
  await mkdir(external);
  await writeFile(path.join(external, `rollout-${id(11)}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: id(11), cwd: scope } })}\n`);
  await symlink(external, path.join(sessionsRoot, '2026', '11', '06'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await discoverCodex(options);
  assert.deepEqual(result.files.map(file => file.sessionId), [id(1)]);
  assert.equal(result.stats.invalidHeaders, 5);
  assert.equal(result.stats.candidateFiles, 6);
  assert.ok(result.stats.headerBytes <= 6 * 64 * 1024);
  assert.ok(result.stats.tailBytes <= 64 * 1024);
});

test('explicit scopes and valid limits are required; output limits preserve newest sessions', async t => {
  for (const scopeRoots of [undefined, [], ['relative/path'], ['']]) {
    await assert.rejects(discoverCodex({ scopeRoots }), /scopeRoots/);
  }
  const { options, log } = await fixture(t);
  for (const sessionsRoot of [undefined, '', 'relative/path']) {
    await assert.rejects(discoverCodex({ ...options, sessionsRoot }), /sessionsRoot/);
  }
  for (const extra of [{ maxFiles: 0 }, { maxFiles: 101 }, { maxFiles: 1.5 }, { recentHours: 0 }, { now: NaN }]) {
    await assert.rejects(discoverCodex({ ...options, ...extra }), /limits/);
  }
  for (let n = 1; n <= 4; n++) await log(n, { age: n });
  const limited = await discoverCodex({ ...options, maxFiles: 2 });
  assert.deepEqual(limited.files.map(file => file.sessionId), [id(1), id(2)]);
  assert.equal(limited.stats.recentFiles, 4);
  assert.equal(limited.stats.truncated, 2);
});

test('the optional Codex index resolves beside the explicit sessions root', async t => {
  const { options, log, indexPath } = await fixture(t);
  await log(1);
  await writeFile(indexPath, `${JSON.stringify({ id: id(1), updated_at: iso(0), thread_name: 'Explicit profile' })}\n`);
  const { indexPath: omitted, ...withoutIndex } = options;
  assert.equal((await discoverCodex(withoutIndex)).files[0].title, 'Explicit profile');
});

test('tails and indexes are bounded, and malformed or future timestamp records do not create freshness', async t => {
  const { options, log, indexPath } = await fixture(t);
  const fresh = await log(1, { body: `${'x'.repeat(200 * 1024)}\n${JSON.stringify({ timestamp: iso(0) })}\n{partial` });
  const future = new Date(now + 3_600_000).toISOString();
  const invalid = [future, 'invalid', '2026-11-07T18:00:00', '2026-02-30T18:00:00Z', '2026-11-07T24:00:00Z'];
  await log(2, { age: 48, body: invalid.map(timestamp => JSON.stringify({ timestamp })).join('\n') + '\n' });
  await writeFile(indexPath, `${'x'.repeat(8 * 1024 * 1024 + 100)}\n{malformed}\n${JSON.stringify({ id: id(2), updated_at: future })}\n`);
  const result = await discoverCodex(options);
  assert.deepEqual(result.files.map(file => file.path), [fresh]);
  assert.ok(result.stats.indexBytes <= 8 * 1024 * 1024);
  assert.ok(result.stats.tailBytes <= 2 * 64 * 1024);
  assert.equal(result.files[0].title, null);
});
