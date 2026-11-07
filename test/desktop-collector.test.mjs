import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedLog, commandsForLog, createCollector } from '../lib/desktop/collector.mjs';

const cwd = 'C:/scope/Company/ang';
const roots = ['C:/scope/Company'];
const row = (n, changes = {}) => JSON.stringify({ type: 'assistant', uuid: `row-${n}`, sessionId: 'session-a', cwd,
  timestamp: new Date(Date.UTC(2026, 10, 7, 0, 0, n)).toISOString(), message: { content: [{ type: 'text', text: `synthetic-${n}` }] }, ...changes });
const source = { provider: 'claude', path: 'C:/fixture/log.jsonl', sessionId: 'session-a' };
const fixture = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runward-collector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'fixture.jsonl');
};

test('bounded tails drop partial records and accept only matching cwd and session', async t => {
  const file = await fixture(t);
  await writeFile(file, 'x'.repeat(5000) + '\n' + [row(1), row(2, { cwd: 'C:/scope/CompanyOther' }),
    row(3, { sessionId: 'other' }), row(4), '{"unfinished":'].join('\n'));
  const read = await readBoundedLog(file, undefined, { tailBytes: 2048 });
  assert.equal(read.truncatedPrefix, true);
  const parsed = commandsForLog(read.text, source, roots);
  assert.equal(parsed.commands.filter(item => item.type === 'span.upsert').length, 2);
  assert.equal(parsed.rejectedRows, 2);
  assert.equal(parsed.commands[0].data.cwd, cwd);
});

test('preview events and details are bounded and IDs remain stable', () => {
  const text = [row(1), row(2), row(3, { message: { content: [{ type: 'text', text: 'x'.repeat(2000) }] } })].join('\n');
  const parsed = commandsForLog(text, source, roots, { eventsPerSession: 2, detailChars: 400 });
  const spans = parsed.commands.filter(item => item.type === 'span.upsert');
  assert.equal(spans.length, 2);
  assert.equal(spans[1].data.detail.length, 400);
  assert.match(spans[1].data.detail, /Local preview shortened/);
  assert.deepEqual(parsed.commands, commandsForLog(text, source, roots, { eventsPerSession: 2, detailChars: 400 }).commands);
});

test('configured parser carries scoped Claude turn state through to the preview', () => {
  const message = stop_reason => ({ content: [{ type: 'text', text: 'Synthetic split block' }], stop_reason });
  const working = row(1, { message: message('tool_use') });
  const idle = row(2, { message: message('end_turn') });
  const foreign = row(3, { sessionId: 'foreign', message: message('tool_use') });
  assert.equal(commandsForLog(working, source, roots).commands[0].data.status, 'working');
  assert.equal(commandsForLog([working, idle, foreign].join('\n'), source, roots).commands[0].data.status, 'idle');
});

test('replacements, truncation and rewrites pause; append-only growth is accepted', async t => {
  const file = await fixture(t);
  await writeFile(file, row(1) + '\n');
  const first = await readBoundedLog(file);
  await appendFile(file, row(2) + '\n');
  const second = await readBoundedLog(file, first.binding);
  assert.match(second.text, /synthetic-2/);
  await writeFile(file, row(1).replace('synthetic-1', 'synthetic-X') + '\n' + row(2) + '\n');
  await assert.rejects(readBoundedLog(file, second.binding), { code: 'SOURCE_ANCHOR_CHANGED' });
  await writeFile(file, row(1) + '\n');
  await assert.rejects(readBoundedLog(file, second.binding), { code: 'SOURCE_REPLACED_OR_TRUNCATED' });
  await rename(file, file + '.old');
  await writeFile(file, row(1) + '\n' + row(2) + '\n');
  await assert.rejects(readBoundedLog(file, second.binding), { code: 'SOURCE_REPLACED_OR_TRUNCATED' });
});

test('poll pauses an equal-size rewrite even when the original mtime is restored', async t => {
  const file = await fixture(t);
  const frozen = new Date(Date.UTC(2026, 10, 7));
  const original = row(1) + '\n';
  const rewritten = original.replace('synthetic-1', 'synthetic-X');
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
  await writeFile(file, original);
  await utimes(file, frozen, frozen);
  const batches = [];
  const collector = createCollector({ config: { claudeScopeRoot: roots[0] },
    app: { dispatchSource: async (key, commands) => batches.push(commands) },
    discover: async () => ({ roots, stats: {}, files: [{ path: file, sessionId: 'session-a', cwd }] }) });
  await collector.poll();
  assert.equal(batches.length, 1);
  await writeFile(file, rewritten);
  await utimes(file, frozen, frozen);
  await collector.poll();
  assert.equal(collector.status().files[0].paused, true);
  assert.equal(collector.status().files[0].error, 'SOURCE_ANCHOR_CHANGED');
  assert.equal(batches.length, 1);
});

test('poll deduplicates unchanged records, imports deltas and discovers new sessions', async t => {
  const file = await fixture(t);
  const later = file + '.later';
  await writeFile(file, row(1) + '\n');
  await writeFile(later, row(2, { sessionId: 'session-b' }) + '\n');
  const batches = [];
  let includeLater = false;
  const collector = createCollector({ config: { codexTranscript: file + '.missing-codex', claudeScopeRoot: roots[0],
    claudeRepoRoot: cwd, recentHours: 24, discoveryIntervalMs: 100000, tailBytes: 4096, eventsPerSession: 100, detailChars: 400 },
    app: { dispatchSource: async (key, commands) => batches.push({ key, commands }) },
    discover: async () => ({ roots, stats: {}, files: [{ path: file, sessionId: 'session-a' }, ...(includeLater ? [{ path: later, sessionId: 'session-b' }] : [])] }) });
  await collector.poll();
  assert.equal(batches.length, 1);
  await collector.poll();
  assert.equal(batches.length, 1);
  await appendFile(file, row(2) + '\n');
  await collector.poll();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].commands.filter(command => command.type === 'span.upsert').length, 1);
  assert.equal(batches[1].key, 'desktop-claude:1');
  includeLater = true;
  await collector.refresh();
  await collector.poll();
  assert.equal(batches.length, 3);
  const agentIds = batches.flatMap(batch => batch.commands.filter(command => command.type === 'agent.upsert').map(command => command.data.id));
  assert.equal(new Set(agentIds).size, 2);
});

test('inactive logs stay out until real new activity, even after a metadata-only file touch', async t => {
  const file = await fixture(t);
  const clock = Date.now();
  const old = row(1, { timestamp: new Date(clock - 10 * 60_000).toISOString() });
  await writeFile(file, old + '\n');
  await utimes(file, new Date(clock - 2 * 3600_000), new Date(clock - 2 * 3600_000));
  const batches = [];
  const collector = createCollector({ now: () => clock, config: { codexTranscript: file + '.missing', claudeScopeRoot: roots[0],
    claudeRepoRoot: cwd, recentHours: 24, discoveryIntervalMs: 100000, tailBytes: 4096, eventsPerSession: 100, detailChars: 400, maxSessionAgeMinutes: 5 },
    app: { dispatchSource: async (key, commands) => batches.push(commands) },
    discover: async () => ({ roots, stats: {}, files: [{ path: file, sessionId: 'session-a' }] }) });
  await collector.poll();
  assert.equal(batches.length, 0);
  assert.equal(collector.status().files.find(source => source.path === file).lastReadAt, null);
  await utimes(file, new Date(clock), new Date(clock));
  await collector.poll();
  assert.equal(batches.length, 0);
  await appendFile(file, row(2, { timestamp: new Date(clock).toISOString() }) + '\n');
  await collector.poll();
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].data.lastSeen, new Date(clock).toISOString());
});

test('platform titles and renames replace IDs without manufacturing activity', async t => {
  const file = await fixture(t);
  await writeFile(file, row(1) + '\n');
  const batches = [];
  let title = '测试窗口标题';
  const collector = createCollector({ config: { codexTranscript: file + '.missing', claudeScopeRoot: roots[0],
    claudeRepoRoot: cwd, recentHours: 24, discoveryIntervalMs: 100000, tailBytes: 4096, eventsPerSession: 100, detailChars: 400 },
    app: { dispatchSource: async (key, commands) => batches.push(commands) },
    discover: async () => ({ roots, stats: {}, files: [{ path: file, sessionId: 'session-a', title }] }) });
  await collector.poll();
  const original = batches[0].find(command => command.type === 'agent.upsert').data;
  assert.equal(original.name, title);
  title = '重命名后的窗口';
  await collector.refresh();
  await collector.poll();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 1);
  assert.equal(batches[1][0].data.name, title);
  assert.equal(batches[1][0].data.lastSeen, original.lastSeen);
  const fallback = commandsForLog(row(1), source, roots).commands[0].data.name;
  assert.equal(fallback, 'Claude Code · ang');
  assert.equal(fallback.includes('session-a'), false);
});

test('open Codex and Claude logs keep importing when Windows leaves mtime unchanged', async t => {
  for (const provider of ['codex', 'claude']) {
    const file = await fixture(t);
    let clock = Date.now();
    const frozen = new Date(clock - 2 * 3600_000);
    const at = new Date(clock).toISOString();
    const codex = [
      { type: 'session_meta', timestamp: at, payload: { id: 'session-a', cwd, timestamp: at } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'turn-a' } },
    ].map(value => JSON.stringify(value)).join('\n');
    await writeFile(file, (provider === 'codex' ? codex : row(1, { timestamp: at, message: { content: [], stop_reason: 'tool_use' } })) + '\n');
    await utimes(file, frozen, frozen);
    const batches = [];
    const collector = createCollector({ now: () => clock, config: { codexTranscript: provider === 'codex' ? file : file + '.missing',
      claudeScopeRoot: roots[0], claudeRepoRoot: cwd, recentHours: 24, discoveryIntervalMs: 100000,
      tailBytes: 4096, maxSessionAgeMinutes: 60 },
      app: { dispatchSource: async (key, commands) => batches.push(commands) },
      discover: async () => ({ roots, stats: {}, files: provider === 'claude' ? [{ path: file, sessionId: 'session-a', cwd }] : [] }) });
    await collector.poll();
    assert.equal(batches.length, 1, `${provider}: fresh event must override old mtime`);
    assert.equal(batches[0][0].data.status, 'working');
    const next = new Date(clock + 1000).toISOString();
    await appendFile(file, (provider === 'codex'
      ? JSON.stringify({ type: 'event_msg', timestamp: next, payload: { type: 'task_complete', turn_id: 'turn-a' } })
      : row(2, { timestamp: next, message: { content: [], stop_reason: 'end_turn' } })) + '\n');
    await utimes(file, frozen, frozen);
    clock += 1000;
    await collector.poll();
    assert.equal(batches.length, 2, `${provider}: append must refresh state despite frozen mtime`);
    assert.equal(batches[1][0].data.status, 'idle');
    await collector.poll();
    assert.equal(batches.length, 2, 'unchanged logs remain deduplicated');
  }
});

test('scoped Claude sessions retain lifecycle rows that omit repeated cwd', () => {
  const idle = row(1, { message: { content: [], stop_reason: 'end_turn' } });
  const working = row(2, { cwd: undefined, message: { content: [], stop_reason: 'tool_use' } });
  assert.equal(commandsForLog([idle, working].join('\n'), source, roots).commands[0].data.status, 'working');
  assert.equal(commandsForLog(working, { ...source, cwd }, roots).commands[0].data.status, 'working');
  assert.equal(commandsForLog(working, source, roots).commands.length, 0, 'unscoped tail stays rejected');
  const foreign = row(3, { cwd: 'C:/outside', message: { content: [], stop_reason: 'end_turn' } });
  const missing = row(4, { cwd: undefined, message: { content: [], stop_reason: 'end_turn' } });
  const parsed = commandsForLog([idle, working, foreign, missing].join('\n'), source, roots);
  assert.equal(parsed.commands[0].data.status, 'working');
  assert.equal(parsed.rejectedRows, 2);
});

test('Codex discovery imports multiple main sessions and finds new sessions on refresh', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const at = new Date().toISOString();
  for (const [path, id] of [[first, 'main-a'], [second, 'main-b']]) {
    await writeFile(path, [
      { type: 'session_meta', timestamp: at, payload: { id, cwd, timestamp: at } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: id } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  const batches = [];
  let includeSecond = false;
  const collector = createCollector({ config: { codexTranscript: first, codexSessionsRoot: 'synthetic', codexScopeRoots: roots,
    claudeScopeRoot: roots[0], claudeRepoRoot: cwd, recentHours: 24, discoveryIntervalMs: 100000, tailBytes: 4096 },
    app: { dispatchSource: async (key, commands) => batches.push({ key, commands }) },
    discover: async () => ({ roots, stats: {}, files: [] }),
    discoverCodex: async () => ({ roots, stats: {}, files: [{ path: first, sessionId: 'main-a', cwd },
      ...(includeSecond ? [{ path: second, sessionId: 'main-b', cwd }] : [])] }) });
  await collector.poll();
  assert.equal(batches.length, 1, 'pinned and discovered path import once');
  includeSecond = true;
  await collector.refresh();
  await collector.poll();
  assert.equal(batches.length, 2);
  assert.equal(new Set(batches.map(batch => batch.commands[0].data.id)).size, 2);
  assert.ok(batches.every(batch => batch.key === 'desktop-codex:1' && batch.commands[0].data.status === 'working'));
});

test('Codex discovery keeps case-distinct POSIX paths and deduplicates Windows path spellings', async () => {
  const make = (files, codexTranscript) => createCollector({
    config: { codexTranscript, codexSessionsRoot: '/fixture/sessions', codexScopeRoots: ['/fixture'] },
    app: { dispatchSource: async () => assert.fail('Refresh must not import files') },
    discoverCodex: async () => ({ roots: ['/fixture'], files, stats: {} }),
  });
  const posix = make([{ path: '/fixture/a.jsonl', sessionId: 'main-a' },
    { path: '/fixture/A.jsonl', sessionId: 'main-b' }]);
  await posix.refresh();
  assert.equal(posix.status().selectedCodexFiles, 2);
  assert.deepEqual(posix.status().files.map(({ path, sessionId }) => ({ path, sessionId })), [
    { path: '/fixture/a.jsonl', sessionId: 'main-a' }, { path: '/fixture/A.jsonl', sessionId: 'main-b' },
  ]);
  const windows = make([{ path: 'c:/fixture/session.jsonl', sessionId: 'main-a' }], 'C:\\Fixture\\SESSION.jsonl');
  await windows.refresh();
  assert.equal(windows.status().selectedCodexFiles, 1);
  assert.equal(windows.status().files[0].path, 'c:/fixture/session.jsonl');
  assert.equal(windows.status().files[0].sessionId, 'main-a');
});

test('discovered Codex sources revalidate session and directory before importing', () => {
  const at = new Date().toISOString();
  const selected = { provider: 'codex', path: 'synthetic', sessionId: 'main-a', scoped: true };
  const text = changes => JSON.stringify({ type: 'session_meta', timestamp: at, payload: { id: 'main-a', cwd, ...changes } });
  assert.equal(commandsForLog(text({}), selected, roots).commands.length, 1);
  for (const changes of [{ id: 'foreign' }, { cwd: 'C:/outside' }, { parent_thread_id: 'parent' },
    { forked_from_id: 'parent' }, { source: 'subagent' }, { source: { subagent: {} } }, { source: { subagent: null } }]) {
    assert.equal(commandsForLog(text(changes), selected, roots).commands.length, 0);
  }
  const headerParent = JSON.stringify({ type: 'session_meta', timestamp: at, parent_thread_id: 'parent',
    payload: { id: 'main-a', cwd } });
  assert.equal(commandsForLog(headerParent, selected, roots).commands.length, 0);
});

test('Codex-only collection does not discover Claude and uses the explicit title index', async t => {
  const file = (await fixture(t)) + '-00000000-0000-4000-8000-000000000001.jsonl';
  const index = await fixture(t);
  const at = new Date().toISOString();
  await writeFile(file, [
    { type: 'session_meta', timestamp: at, payload: { id: '00000000-0000-4000-8000-000000000001', cwd } },
    { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'turn-a' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  await writeFile(index, JSON.stringify({ id: '00000000-0000-4000-8000-000000000001',
    thread_name: 'Synthetic desktop session', updated_at: at }) + '\n');
  const batches = [];
  const collector = createCollector({ config: { codexTranscript: file, codexIndexPath: index },
    app: { dispatchSource: async (key, commands) => batches.push({ key, commands }) },
    discover: async () => { assert.fail('Claude discovery must remain disabled'); } });
  await collector.poll();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].key, 'desktop-codex:1');
  assert.equal(batches[0].commands[0].data.name, 'Synthetic desktop session');
  assert.equal(batches[0].commands[0].data.status, 'working');
  assert.equal(collector.status().selectedClaudeFiles, 0);
});

test('collection forwards only the configured provider discovery locations', async () => {
  const clock = Date.now();
  const seen = {};
  const config = { claudeScopeRoot: roots[0], claudeRepoRoot: cwd,
    claudeProjectsRoot: 'C:/fixture/claude-projects', claudeRegistryRoot: 'C:/fixture/claude-registry',
    codexSessionsRoot: 'C:/fixture/codex-sessions', codexScopeRoots: roots,
    codexIndexPath: 'C:/fixture/codex-index.jsonl', recentHours: 24 };
  const collector = createCollector({ config, now: () => clock, app: { dispatchSource: async () => assert.fail('No selected files') },
    discover: async options => { seen.claude = options; return { roots, files: [], stats: {} }; },
    discoverCodex: async options => { seen.codex = options; return { roots, files: [], stats: {} }; } });
  await collector.poll();
  assert.deepEqual(seen.claude, { scopeRoot: config.claudeScopeRoot, repoRoot: config.claudeRepoRoot,
    projectsRoot: config.claudeProjectsRoot, registryRoot: config.claudeRegistryRoot, recentHours: 24, now: clock });
  assert.deepEqual(seen.codex, { sessionsRoot: config.codexSessionsRoot, scopeRoots: roots,
    indexPath: config.codexIndexPath, recentHours: 24, now: clock });
});

test('revoked source collection remains paused across appended logs and discovery refreshes', async t => {
  const file = await fixture(t);
  await writeFile(file, row(1) + '\n');
  let attempts = 0;
  const collector = createCollector({ config: { claudeScopeRoot: roots[0] },
    app: { dispatchSource: async () => { attempts++; throw Object.assign(new Error('revoked'), { code: 'SOURCE_REVOKED' }); } },
    discover: async () => ({ roots, stats: {}, files: [{ path: file, sessionId: 'session-a', cwd }] }) });
  await collector.poll();
  assert.equal(collector.status().files[0].paused, true);
  assert.equal(collector.status().files[0].error, 'SOURCE_REVOKED');
  await appendFile(file, row(2) + '\n');
  await collector.refresh();
  await collector.poll();
  assert.equal(attempts, 1);
  assert.equal(collector.status().files[0].paused, true);
});
