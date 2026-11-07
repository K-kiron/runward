import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopConfig, runDesktopOverview } from '../scripts/desktop-overview.mjs';

const domain = { id: 'desktop-test', environmentId: 'synthetic' };
test('desktop configuration requires explicit scopes and resolves paths relative to its file', () => {
  const base = resolve('synthetic');
  const config = desktopConfig({ domain, codexSessionsRoot: './logs', codexScopeRoots: ['./workspace'] }, base);
  assert.equal(config.codexSessionsRoot, join(base, 'logs'));
  assert.deepEqual(config.codexScopeRoots, [join(base, 'workspace')]);
  assert.equal(config.pollIntervalMs, 2000);
  for (const value of [{ domain }, { domain, codexSessionsRoot: './logs' },
    { domain, codexScopeRoots: ['./workspace'] }, { domain, claudeScopeRoot: './workspace' },
    { domain, claudeRegistryRoot: './registry' }, { domain, codexTranscript: './log', token: 'not-a-token' },
    { domain, codexTranscript: './log', pollIntervalMs: 0 }, { domain, codexTranscript: './log', eventsPerSession: 1000 }]) {
    assert.throws(() => desktopConfig(value, base));
  }
});

test('runnable desktop overview discovers multiple sessions and updates frozen-mtime logs over HTTP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runward-desktop-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'sessions');
  const day = join(root, '2026', '01', '02');
  const workspace = join(directory, 'workspace');
  await mkdir(day, { recursive: true });
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const files = new Map();
  const create = async n => {
    const file = join(day, `rollout-synthetic-${id(n)}.jsonl`);
    const at = new Date(Date.now() - 100).toISOString();
    await writeFile(file, [
      { type: 'session_meta', timestamp: at, payload: { id: id(n), cwd: workspace, timestamp: at } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: `turn-${n}` } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await utimes(file, new Date(0), new Date(0));
    files.set(n, file);
  };
  await create(1);
  await create(2);
  const config = desktopConfig({ domain, codexSessionsRoot: root, codexScopeRoots: [workspace],
    pollIntervalMs: 100, discoveryIntervalMs: 100 });
  const overview = await runDesktopOverview(config, { env: {}, log: () => {}, report: () => {}, listenPort: 0 });
  t.after(() => overview.stop());
  const snapshot = async () => {
    const response = await fetch(`${overview.url}/api/state`, { headers: { Authorization: `Bearer ${overview.app.tokens.read}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await snapshot();
  assert.equal(first.agents.length, 2);
  assert.ok(first.agents.every(agent => agent.status === 'working'));
  assert.equal((await fetch(`${overview.url}/api/state`)).status, 401);
  await appendFile(files.get(1), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'task_complete', turn_id: 'turn-1' } }) + '\n');
  await utimes(files.get(1), new Date(0), new Date(0));
  await create(3);
  const deadline = Date.now() + 5000;
  let latest;
  do {
    await delay(50);
    latest = await snapshot();
  } while ((latest.agents.length !== 3 || !latest.agents.some(agent => agent.status === 'idle')) && Date.now() < deadline);
  assert.equal(latest.agents.length, 3);
  assert.equal(latest.agents.filter(agent => agent.status === 'working').length, 2);
  assert.equal(latest.agents.filter(agent => agent.status === 'idle').length, 1);
});
