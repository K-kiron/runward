import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sanitizeTitle, readCodexTitle } from '../lib/desktop/titles.mjs';

test('titles preserve Unicode as plain text, collapse controls and stay bounded', () => {
  assert.equal(sanitizeTitle('  窗口\n标题\u0000\t <b>原文</b>  '), '窗口 标题 <b>原文</b>');
  assert.equal(sanitizeTitle('😀'.repeat(200)), '😀'.repeat(80));
  assert.equal(sanitizeTitle('a'.repeat(159) + '😀'), 'a'.repeat(159));
  for (const value of [null, undefined, {}, 42, ' \n\u0000 ']) assert.equal(sanitizeTitle(value), null);
});

test('Codex title lookup requires an explicit absolute index location', async () => {
  for (const options of [undefined, {}, { indexPath: 'relative.jsonl' }]) {
    await assert.rejects(readCodexTitle('target', options), /explicit absolute indexPath/);
  }
});

test('Codex uses only exact ID, latest timestamp and refreshes renames', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'codex-titles-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const indexPath = path.join(base, 'session_index.jsonl');
  const record = (id, thread_name, updated_at) => JSON.stringify({ id, thread_name, updated_at });
  await writeFile(indexPath, [
    record('target-other', 'Unrelated', '2026-11-07'),
    record('target', '最新窗口', '2026-11-06'),
    record('target', 'Older title', '2026-11-05'),
    '{incomplete',
  ].join('\n'));
  assert.equal(await readCodexTitle('target', { indexPath }), '最新窗口');
  assert.equal(await readCodexTitle('missing', { indexPath }), null);
  await writeFile(indexPath, record('target', '重命名窗口', '2026-11-07'));
  assert.equal(await readCodexTitle('target', { indexPath }), '重命名窗口');
  await writeFile(indexPath, record('target', null, '2026-11-07'));
  assert.equal(await readCodexTitle('target', { indexPath }), null);
  assert.equal(await readCodexTitle('target', { indexPath: path.join(base, 'missing') }), null);
});
