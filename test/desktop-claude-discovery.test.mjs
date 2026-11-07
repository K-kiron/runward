import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverClaude } from '../lib/desktop/claude-discovery.mjs';
import { isCwdAllowed } from '../lib/desktop/scope.mjs';

const scopeRoot = 'C:/scope/Company';
const external = 'C:/worktrees/external/app';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('Windows scope boundaries and explicit external worktrees', () => {
  assert.equal(isCwdAllowed('c:\\SCOPE\\Company\\app', [scopeRoot]), true);
  assert.equal(isCwdAllowed(`${scopeRoot}Other/app`, [scopeRoot]), false);
  assert.equal(isCwdAllowed(external, [scopeRoot, external]), true);
  assert.equal(isCwdAllowed(`${external}Other`, [scopeRoot, external]), false);
  assert.equal(isCwdAllowed(`${scopeRoot}/../CompanyOther`, [scopeRoot]), false);
  assert.equal(isCwdAllowed('relative/path', [scopeRoot]), false);
  assert.equal(isCwdAllowed('/workspace/app', ['/workspace']), true);
  assert.equal(isCwdAllowed('/Workspace/app', ['/workspace']), false);
  assert.equal(isCwdAllowed('/workspace', ['/']), true);
  assert.equal(isCwdAllowed('/workspace-other', ['/workspace']), false);
});

test('Claude requires explicit input and scope roots and never infers home locations', async t => {
  const projectsRoot = await mkdtemp(path.join(tmpdir(), 'claude-explicit-roots-'));
  t.after(() => rm(projectsRoot, { recursive: true, force: true }));
  for (const options of [{}, { scopeRoot }, { projectsRoot }, { scopeRoot: 'relative', projectsRoot }]) {
    await assert.rejects(discoverClaude(options), /explicit absolute/);
  }
  for (const extra of [{ repoRoot: 'relative' }, { registryRoot: 'relative' }, { worktreeRoots: ['relative'] }]) {
    await assert.rejects(discoverClaude({ scopeRoot, projectsRoot, ...extra }), /absolute optional roots/);
  }
  const result = await discoverClaude({ scopeRoot, projectsRoot });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.roots, [scopeRoot]);
  assert.equal(result.stats.registryFiles, 0);
  assert.equal(result.stats.gitError, false);
});

test('Claude finds Windows project keys with different casing without a registry', async t => {
  const projectsRoot = await mkdtemp(path.join(tmpdir(), 'claude-windows-key-case-'));
  t.after(() => rm(projectsRoot, { recursive: true, force: true }));
  const directory = path.join(projectsRoot, 'c--scope-company');
  await mkdir(directory);
  await writeFile(path.join(directory, `${id(1)}.jsonl`), 'synthetic recent transcript');
  const result = await discoverClaude({ scopeRoot: 'C:/Scope/Company', projectsRoot });
  assert.deepEqual(result.files.map(file => file.sessionId), [id(1)]);
  assert.equal(result.stats.registryFiles, 0);
});

test('Claude keeps POSIX project key matching case-sensitive', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'claude-posix-key-case-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const [key, expected] of [['-workspace-company', [id(1)]], ['-workspace-Company', []]]) {
    const projectsRoot = path.join(base, expected.length ? 'exact' : 'different');
    const directory = path.join(projectsRoot, key);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id(1)}.jsonl`), 'synthetic recent transcript');
    const result = await discoverClaude({ scopeRoot: '/workspace/company', projectsRoot });
    assert.deepEqual(result.files.map(file => file.sessionId), expected);
  }
});

test('registry titles follow only explicit scoped CLI IDs and refresh independently of logs', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'claude-title-discovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const registryRoot = path.join(base, 'registry');
  const projectsRoot = path.join(base, 'projects');
  const current = `${scopeRoot}/app`;
  const directory = path.join(projectsRoot, current.replaceAll('/', '\\').replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(registryRoot, { recursive: true });
  await mkdir(directory, { recursive: true });
  for (const n of [1, 2, 3, 4]) await writeFile(path.join(directory, `${id(n)}.jsonl`), 'not transcript JSON');
  const registryPath = path.join(registryRoot, 'local_current.json');
  const metadata = { cwd: current, cliSessionId: id(1), priorCliSessionIds: [id(2)], lastAssistantCliSessionId: id(3), title: '  中文\n窗口  ' };
  await writeFile(registryPath, JSON.stringify(metadata));
  await writeFile(path.join(registryRoot, 'local_other.json'), JSON.stringify({ cwd: 'C:/unrelated', cliSessionId: id(4), title: 'Unrelated title' }));
  const options = { scopeRoot, repoRoot: `${scopeRoot}/app`, projectsRoot, registryRoot, worktreeRoots: [] };
  const first = await discoverClaude(options);
  for (const n of [1, 2, 3]) assert.equal(first.files.find(file => file.sessionId === id(n)).title, '中文 窗口');
  assert.equal(first.files.find(file => file.sessionId === id(4)).title, null);
  const originalMtime = first.files.find(file => file.sessionId === id(1)).mtimeMs;
  await writeFile(registryPath, JSON.stringify({ ...metadata, title: '更新后的窗口名称' }));
  const second = await discoverClaude(options);
  assert.equal(second.files.find(file => file.sessionId === id(1)).title, '更新后的窗口名称');
  assert.equal(second.files.find(file => file.sessionId === id(1)).mtimeMs, originalMtime);
  await writeFile(registryPath, JSON.stringify({ ...metadata, title: null }));
  assert.equal((await discoverClaude(options)).files.find(file => file.sessionId === id(1)).title, null);
});

test('discovers current scope, migrated IDs, new worktrees and freshness without transcript reads', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'claude-discovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const registryRoot = path.join(base, 'registry');
  const projectsRoot = path.join(base, 'projects');
  await mkdir(registryRoot, { recursive: true });
  const now = Date.now();
  const options = { scopeRoot, repoRoot: `${scopeRoot}/app`, registryRoot, projectsRoot, now, worktreeRoots: [external] };
  const transcript = async (cwd, n, age = 0) => {
    const key = cwd.replaceAll('/', '\\').replace(/[^A-Za-z0-9]/g, '-');
    const directory = path.join(projectsRoot, key);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${id(n)}.jsonl`);
    await writeFile(file, 'invalid JSON proves discovery does not parse transcript bodies');
    await utimes(file, (now - age) / 1000, (now - age) / 1000);
    return file;
  };
  const registry = async (n, value) => writeFile(path.join(registryRoot, `local_${n}.json`), JSON.stringify(value));
  const current = `${scopeRoot}/app`;
  await transcript(current, 1);
  await transcript(external, 2);
  await transcript(current, 3, 25 * 3600000);
  await transcript(`${scopeRoot}Other`, 4);
  await registry(4, { cwd: `${scopeRoot}Other`, originCwd: current, cliSessionId: id(4) });
  // A session can retain its old project directory after its allowed cwd changes.
  await transcript('C:/old-location', 5);
  await registry(5, { cwd: current, cliSessionId: id(5), priorCliSessionIds: [id(6)] });
  await transcript('C:/old-location', 6);
  await transcript(`${scopeRoot}/future-worktree`, 7);
  const first = await discoverClaude(options);
  assert.deepEqual(new Set(first.files.map(file => file.sessionId)), new Set([1, 2, 5, 6].map(id)));
  assert.equal(first.stats.registryMatched, 1);
  assert.equal(first.stats.registryErrors, 0);
  await registry(7, { cwd: `${scopeRoot}/future-worktree`, cliSessionId: id(7) });
  const second = await discoverClaude(options);
  assert.equal(second.files.some(file => file.sessionId === id(7)), true);
  assert.equal(second.stats.registryCacheHits, 2);
  const old = first.files.find(file => file.sessionId === id(1));
  await utimes(old.path, (now - 26 * 3600000) / 1000, (now - 26 * 3600000) / 1000);
  assert.equal((await discoverClaude(options)).files.some(file => file.sessionId === id(1)), false);
  const limited = await discoverClaude({ ...options, maxFiles: 2 });
  assert.equal(limited.files.length, 2);
  assert.equal(limited.stats.truncated, 2);
  await transcript('C:/another-old-location', 8);
  await registry(8, { originCwd: current, lastAssistantCliSessionId: id(8) });
  assert.equal((await discoverClaude(options)).files.some(file => file.sessionId === id(8)), true);
  // Updating existing metadata invalidates the projected cache; origin cannot override a moved cwd.
  await registry(8, { cwd: 'C:/unrelated-project', originCwd: current, lastAssistantCliSessionId: id(8) });
  assert.equal((await discoverClaude(options)).files.some(file => file.sessionId === id(8)), false);
});

async function oldMtimeFixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'claude-old-mtime-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const current = `${scopeRoot}/app`;
  const projectsRoot = path.join(base, 'projects');
  const directory = path.join(projectsRoot, current.replaceAll('/', '\\').replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(directory, { recursive: true });
  const now = Date.parse('2026-03-01T12:00:00Z');
  const options = { scopeRoot, repoRoot: `${scopeRoot}/app`, projectsRoot, registryRoot: path.join(base, 'registry'), worktreeRoots: [], now };
  const row = (n, changes = {}) => ({ type: 'assistant', sessionId: id(n), cwd: current,
    timestamp: new Date(now - 1000).toISOString(), message: { content: [] }, ...changes });
  const transcript = async (n, text, age = 25 * 3600000) => {
    const file = path.join(directory, `${id(n)}.jsonl`);
    await writeFile(file, text);
    await utimes(file, (now - age) / 1000, (now - age) / 1000);
    return file;
  };
  return { base, current, directory, now, options, row, transcript };
}

test('old file mtimes retain recent scoped Claude events without accepting foreign or invalid records', async t => {
  const { now, options, row, transcript } = await oldMtimeFixture(t);
  await transcript(1, `${JSON.stringify(row(1))}\n`);
  await transcript(2, `${JSON.stringify(row(2, { cwd: undefined }))}\n`);
  await transcript(3, `${JSON.stringify(row(3, { timestamp: new Date(now - 25 * 3600000).toISOString() }))}\n`);
  await transcript(4, `${JSON.stringify(row(4, { sessionId: id(99) }))}\n`);
  await transcript(5, `${JSON.stringify(row(5, { cwd: `${scopeRoot}Other/app` }))}\n`);
  await transcript(6, `${JSON.stringify(row(6, { timestamp: new Date(now + 1).toISOString() }))}\n`);
  await transcript(7, `${JSON.stringify(row(7, { timestamp: '2026-02-29T12:00:00Z' }))}\n`);
  await transcript(8, `${JSON.stringify(row(8, { timestamp: '2026-03-01T12:00:00' }))}\n`);
  await transcript(9, `${JSON.stringify(row(9, { type: 'progress' }))}\n`);
  await transcript(10, `${JSON.stringify(row(10, { message: undefined }))}\n`);
  await transcript(11, `${JSON.stringify(row(11, { cwd: null }))}\n`);
  await transcript(12, `${JSON.stringify(row(12, { timestamp: new Date(now - 24 * 3600000).toISOString() }))}\n`);
  const result = await discoverClaude(options);
  assert.deepEqual(new Set(result.files.map(file => file.sessionId)), new Set([1, 2, 12].map(id)));
  assert.equal(result.files.find(file => file.sessionId === id(1)).latestActivityAt, new Date(now - 1000).toISOString());
});

test('old-mtime freshness uses complete records in a bounded tail and keeps maxFiles ordering', async t => {
  const { now, options, row, transcript } = await oldMtimeFixture(t);
  // A large unsupported record pushes a formerly recent event outside the bounded tail.
  await transcript(1, `${JSON.stringify(row(1))}\n${JSON.stringify({ padding: 'x'.repeat(300 * 1024) })}\n`);
  await transcript(2, `${'x'.repeat(300 * 1024)}\n${JSON.stringify(row(2))}\n`);
  await transcript(3, `${JSON.stringify(row(3, { timestamp: new Date(now - 25 * 3600000).toISOString() }))}\n{"type":"assistant","sessionId":`);
  await transcript(4, JSON.stringify(row(4)));
  await transcript(5, 'new mtime needs no transcript parsing', 5 * 60000);
  const result = await discoverClaude(options);
  assert.deepEqual(new Set(result.files.map(file => file.sessionId)), new Set([2, 5].map(id)));
  const limited = await discoverClaude({ ...options, maxFiles: 1 });
  assert.deepEqual(limited.files.map(file => file.sessionId), [id(2)]);
  assert.equal(limited.stats.truncated, 1);
});

test('Claude transcript discovery skips non-files and symbolic links', async t => {
  const { base, directory, options, row, transcript } = await oldMtimeFixture(t);
  await mkdir(path.join(directory, `${id(1)}.jsonl`));
  const target = path.join(base, 'target.jsonl');
  await writeFile(target, `${JSON.stringify(row(2))}\n`);
  try { await symlink(target, path.join(directory, `${id(2)}.jsonl`), 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic(`Symbolic-link creation unavailable: ${error.code}`);
  }
  await transcript(3, `${JSON.stringify(row(3))}\n`);
  assert.deepEqual((await discoverClaude(options)).files.map(file => file.sessionId), [id(3)]);
});

test('unchanged old Claude logs reuse metadata-only tail results while the cutoff advances', async t => {
  const { now, options, row, transcript } = await oldMtimeFixture(t);
  await transcript(1, `${JSON.stringify(row(1))}\n`);
  const first = await discoverClaude(options);
  assert.equal(first.stats.tailCheckedFiles, 1);
  const second = await discoverClaude(options);
  assert.equal(second.stats.tailCheckedFiles, 0, 'unchanged metadata must avoid another tail read');
  assert.equal(second.stats.tailCacheHits, 1);
  assert.deepEqual(second.files, first.files);
  const expired = await discoverClaude({ ...options, now: now + 25 * 3600000 });
  assert.equal(expired.stats.tailCacheHits, 1);
  assert.equal(expired.stats.tailCheckedFiles, 0);
  assert.equal(expired.files.length, 0, 'cached activity must still obey the current cutoff');
  const newRoots = await discoverClaude({ ...options, worktreeRoots: [external] });
  assert.equal(newRoots.stats.tailCheckedFiles, 1, 'scope changes must not reuse scoped cache results');
});

test('appending with frozen Claude mtime invalidates a cached inactive tail', async t => {
  const { now, options, row, transcript } = await oldMtimeFixture(t);
  const file = await transcript(1, `${JSON.stringify(row(1, { timestamp: new Date(now - 26 * 3600000).toISOString() }))}\n`);
  assert.equal((await discoverClaude(options)).files.length, 0);
  const unchanged = await discoverClaude(options);
  assert.equal(unchanged.stats.tailCheckedFiles, 0);
  assert.equal(unchanged.stats.tailCacheHits, 1);
  await appendFile(file, `${JSON.stringify(row(1))}\n`);
  const frozen = new Date(now - 25 * 3600000);
  await utimes(file, frozen, frozen);
  const appended = await discoverClaude(options);
  assert.equal(appended.stats.tailCacheHits, 0);
  assert.equal(appended.stats.tailCheckedFiles, 1);
  assert.deepEqual(appended.files.map(candidate => candidate.sessionId), [id(1)]);
});

test('request-only append rediscovers an inactive Claude file with frozen mtime', async t => {
  const { now, current, options, transcript } = await oldMtimeFixture(t);
  const file = await transcript(1, 'unsupported old transcript\n');
  assert.equal((await discoverClaude(options)).files.length, 0);
  await appendFile(file, JSON.stringify({ type: 'api-request', id: 'request-a', sessionId: id(1), cwd: current,
    timestamp: new Date(now - 1000).toISOString(), params: { body: 'PRIVATE_REQUEST_BODY' } }) + '\n');
  const frozen = new Date(now - 25 * 3600000);
  await utimes(file, frozen, frozen);
  const appended = await discoverClaude(options);
  assert.deepEqual(appended.files.map(candidate => candidate.sessionId), [id(1)]);
  assert.equal(appended.files[0].latestActivityAt, new Date(now - 1000).toISOString());
  assert.equal(appended.stats.tailCheckedFiles, 1);
  assert.doesNotMatch(JSON.stringify(appended), /PRIVATE_REQUEST_BODY/);
});

test('old Claude request tails validate scope, IDs, flags, timestamps and complete bounded records', async t => {
  const { now, current, options, transcript } = await oldMtimeFixture(t);
  const request = (n, changes = {}) => ({ type: 'api-request', id: `request-${n}`, sessionId: id(n), cwd: current,
    timestamp: new Date(now - 1000).toISOString(), ...changes });
  const cases = [
    {}, { cwd: undefined }, { id: '' }, { id: '  ' }, { id: null }, { id: 4 },
    { sessionId: id(99) }, { cwd: `${scopeRoot}Other/app` }, { cwd: null },
    { timestamp: new Date(now + 1000).toISOString() }, { timestamp: '2026-02-29T12:00:00Z' },
    { timestamp: '2026-03-01T12:00:00' }, { isApiErrorMessage: true }, { isMeta: true },
    { isVisibleInTranscriptOnly: true }, { isCompactSummary: true },
  ];
  for (const [index, changes] of cases.entries()) await transcript(index + 1, JSON.stringify(request(index + 1, changes)) + '\n');
  await transcript(20, JSON.stringify(request(20)));
  await transcript(21, JSON.stringify(request(21)) + '\n' + JSON.stringify({ padding: 'x'.repeat(300 * 1024) }) + '\n');
  await transcript(22, 'x'.repeat(300 * 1024) + '\n' + JSON.stringify(request(22)) + '\n');
  await transcript(23, '{"type":"api-request","id":\n');
  const first = await discoverClaude(options);
  assert.deepEqual(new Set(first.files.map(file => file.sessionId)), new Set([1, 2, 22].map(id)));
  const later = await discoverClaude({ ...options, now: now + 2000 });
  assert.deepEqual(new Set(later.files.map(file => file.sessionId)), new Set([1, 2, 10, 22].map(id)),
    'a previously future request is rechecked rather than cached as permanently inactive');
});

test('Claude tail freshness revokes inherited cwd after foreign requests and messages', async t => {
  const { now, current, options, row, transcript } = await oldMtimeFixture(t);
  const request = (n, changes = {}) => ({ type: 'api-request', id: `request-${n}`, sessionId: id(n), cwd: current,
    timestamp: new Date(now - 1000).toISOString(), ...changes });
  const files = [];
  for (const [index, foreign] of [request(1, { sessionId: id(99) }), request(2, { cwd: 'C:/outside' }),
    row(3, { sessionId: id(99) }), row(4, { cwd: 'C:/outside' })].entries()) {
    const n = index + 1;
    files.push(await transcript(n, [request(n, { timestamp: new Date(now - 26 * 3600000).toISOString() }), foreign,
      request(n, { cwd: undefined })].map(value => JSON.stringify(value)).join('\n') + '\n'));
  }
  assert.equal((await discoverClaude(options)).files.length, 0);
  for (const [index, file] of files.entries()) {
    await appendFile(file, JSON.stringify(request(index + 1)) + '\n');
    const frozen = new Date(now - 25 * 3600000);
    await utimes(file, frozen, frozen);
  }
  assert.deepEqual(new Set((await discoverClaude(options)).files.map(file => file.sessionId)), new Set([1, 2, 3, 4].map(id)),
    'an explicit allowed cwd restores matching-session scope');
});

test('future Claude timestamps are rechecked when time advances without file changes', async t => {
  const { now, options, row, transcript } = await oldMtimeFixture(t);
  await transcript(1, `${JSON.stringify(row(1, { timestamp: new Date(now + 1000).toISOString() }))}\n`);
  const first = await discoverClaude(options);
  assert.equal(first.files.length, 0);
  const later = await discoverClaude({ ...options, now: now + 2000 });
  assert.equal(later.stats.tailCheckedFiles, 1);
  assert.equal(later.stats.tailCacheHits, 0);
  assert.deepEqual(later.files.map(candidate => candidate.sessionId), [id(1)]);
});
