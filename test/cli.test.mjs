import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, rename, access, mkdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { resolveCLI, runCLI } from '../cli.mjs';
import { applyCommands, emptyState } from '../lib/model.mjs';
import { createStore, validateStore } from '../lib/domain.mjs';

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return String(port);
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for CLI import');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('live CLI requires an explicit domain and environment and never selects the legacy default store', async t => {
  const home = await mkdtemp(join(tmpdir(), 'runward-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(resolveCLI([], { home }), /domain.*environment/i);
  await assert.rejects(resolveCLI(['--domain', 'personal'], { home }), /domain.*environment/i);
  const command = await resolveCLI(['--domain', 'personal', '--environment', 'laptop'], { home });
  assert.equal(command.dataFile, join(home, '.runward', 'domains', 'personal', 'laptop', 'state.json'));
  assert.deepEqual(command.domain, { id: 'personal', environmentId: 'laptop' });
});

test('migration requires named agents, a destination domain, an enrollment id and an explicit fresh path', async () => {
  const args = ['migrate', 'legacy.json', '--domain', 'personal', '--environment', 'laptop', '--source-id', 'archive', '--data', 'new-state.json'];
  await assert.rejects(resolveCLI(args), /explicit.*agent/i);
  await assert.rejects(resolveCLI([...args, '--agent', 'one', '--config', 'domain.json']), /cannot.*combine/i);
  await assert.rejects(resolveCLI(['migrate', 'legacy.json', '--agent', 'one', '--domain', 'personal', '--environment', 'laptop', '--source-id', 'archive']), /--data/);
  const command = await resolveCLI([...args, '--agent', 'one', '--agent', 'two']);
  assert.equal(command.command, 'migrate');
  assert.deepEqual(command.agentIds, ['one', 'two']);
  assert.equal(command.source.id, 'archive');
  assert.equal(command.source.generation, 1);
  assert.deepEqual(command.source.identity, { alias: null, evidence: 'unknown' });
  await assert.rejects(resolveCLI(['migrate', 'same.json', '--agent', 'one', '--domain', 'personal', '--environment', 'laptop', '--source-id', 'archive', '--data', 'same.json']), /different/);
});

test('ingest uses only the source capability and purge uses only the action capability', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-http-cli-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'events.json');
  await writeFile(file, JSON.stringify({ type: 'agent.upsert', data: { id: 'synthetic' } }));
  const received = [];
  const server = http.createServer(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    received.push({ path: request.url, authorization: request.headers.authorization, headers: request.headers, body: Buffer.concat(parts).toString() });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, revision: 1 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = String(server.address().port);
  await assert.rejects(runCLI(['ingest', file, '--port', port], { env: { RUNWARD_TOKEN: 'synthetic-action' }, log: () => {} }), /^Error: Set RUNWARD_INGEST_TOKEN/);
  await runCLI(['ingest', file, '--port', port], { env: { RUNWARD_INGEST_TOKEN: 'synthetic-ingest', RUNWARD_TOKEN: 'synthetic-action' }, log: () => {} });
  await runCLI(['purge', 'selected', '--port', port], { env: { RUNWARD_TOKEN: 'synthetic-action' }, log: () => {} });
  assert.equal(received[0].path, '/api/events');
  assert.equal(received[0].authorization, 'Bearer synthetic-ingest');
  assert.equal(Object.hasOwn(received[0].headers, 'x-runward-source'), false);
  assert.equal(received[1].path, '/api/sources/selected/purge');
  assert.equal(received[1].authorization, 'Bearer synthetic-action');
  assert.deepEqual(JSON.parse(received[1].body), {});
  await assert.rejects(resolveCLI(['ingest', file, '--domain', 'personal']), /cannot.*combine/i);
});

test('migration writes only explicitly selected history and never overwrites its input or destination', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-migration-cli-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const input = join(folder, 'legacy.json');
  const target = join(folder, 'domain.json');
  const legacy = applyCommands(emptyState(), [
    { type: 'agent.upsert', data: { id: 'personal-agent', name: 'Personal synthetic' } },
    { type: 'agent.upsert', data: { id: 'company-agent', name: 'Company synthetic' } },
    { type: 'span.upsert', data: { id: 'personal-span', agentId: 'personal-agent', detail: 'Selected synthetic history' } },
    { type: 'span.upsert', data: { id: 'company-span', agentId: 'company-agent', detail: 'Unselected synthetic history' } },
  ]);
  const original = JSON.stringify(legacy);
  await writeFile(input, original);
  const args = ['migrate', input, '--agent', 'personal-agent', '--domain', 'personal', '--environment', 'laptop', '--source-id', 'archive', '--data', target];
  const migrated = await runCLI(args, { env: {}, log: () => {} });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.state.agents.length, 1);
  assert.equal(migrated.state.events[0].detail, 'Selected synthetic history');
  const published = await readFile(target, 'utf8');
  assert.equal(published.includes('Company synthetic'), false);
  assert.equal(await readFile(input, 'utf8'), original);
  await assert.rejects(runCLI(args, { env: {}, log: () => {} }), /EEXIST|exist/i);
  assert.equal(await readFile(target, 'utf8'), published);
  assert.equal(await readFile(input, 'utf8'), original);
  await assert.rejects(access(`${target}.lock`), { code: 'ENOENT' });
});

test('live CLI persists file enrollment and rejects replacing the selected file across a restart', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-restart-cli-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const input = join(folder, 'session.jsonl');
  const target = join(folder, 'state.json');
  const row = JSON.stringify({ timestamp: '2026-01-02T09:00:00Z', type: 'response_item', payload: { type: 'message', id: 'one', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic selected log' }] } });
  await writeFile(input, row);
  const args = ['--domain', 'personal', '--environment', 'laptop', '--data', target, '--port', await freePort(), '--watch', `codex=${input}`];
  const output = [];
  const live = await runCLI(args, { env: {}, log: value => output.push(value) });
  t.after(() => live.stop());
  await until(() => live.app.snapshot().events.length === 1);
  const readToken = live.app.tokens.read;
  assert.ok(output.some(value => value.includes('Read token:')));
  assert.ok(output.some(value => value.includes('Ingest token [')));
  await live.stop();
  const saved = await readFile(target, 'utf8');
  assert.equal(saved.includes(readToken), false);
  assert.ok(JSON.parse(saved).sources[0].fileIdentity.ino);
  await rename(input, join(folder, 'previous.jsonl'));
  await writeFile(input, row);
  await assert.rejects(runCLI(args, { env: {}, log: () => {} }), /enrollment changed.*generation/i);
  assert.equal(await readFile(target, 'utf8'), saved);
  await assert.rejects(access(`${target}.lock`), { code: 'ENOENT' });
});

test('a failed listen releases the domain state lock', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-listen-cli-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const target = join(folder, 'state.json');
  await assert.rejects(runCLI(['--domain', 'personal', '--environment', 'laptop', '--data', target, '--port', String(occupied.address().port)], { env: {}, log: () => {} }), { code: 'EADDRINUSE' });
  await assert.rejects(access(`${target}.lock`), { code: 'ENOENT' });
});

test('easy watch enrolls the same canonical file deterministically and rejects duplicate selection', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-watch-cli-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'selected.jsonl');
  await writeFile(path, '');
  const common = ['--domain', 'personal', '--environment', 'laptop'];
  const first = await resolveCLI([...common, '--watch', 'codex=./selected.jsonl'], { cwd: folder });
  const second = await resolveCLI([...common, '--watch', `codex=${path}`], { cwd: folder });
  assert.equal(first.sources.length, 1);
  assert.equal(first.sources[0].id, second.sources[0].id);
  assert.equal(first.sources[0].generation, 1);
  assert.deepEqual(first.sources[0].identity, { alias: null, evidence: 'unknown' });
  await assert.rejects(resolveCLI([...common, '--watch', `codex=${path}`, '--watch', `claude=${path}`]), /only once/i);
});

test('easy watch retains its source id when the same selected junction is retargeted between runs', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-restart-link-cli-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const first = join(folder, 'first');
  const second = join(folder, 'second');
  const link = join(folder, 'selected');
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, 'session.jsonl'), '');
  await writeFile(join(second, 'session.jsonl'), '');
  try { await symlink(first, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM') return t.skip('Directory links are unavailable on this platform');
    throw error;
  }
  const args = ['--domain', 'personal', '--environment', 'laptop', '--watch', `codex=${join(link, 'session.jsonl')}`];
  const enrolled = await resolveCLI(args);
  const store = createStore(enrolled.domain, enrolled.sources);
  await unlink(link);
  await symlink(second, link, process.platform === 'win32' ? 'junction' : 'dir');
  const retargeted = await resolveCLI(args);
  assert.equal(retargeted.sources[0].id, enrolled.sources[0].id);
  assert.equal(retargeted.sources[0].toolInstanceId, enrolled.sources[0].toolInstanceId);
  assert.notEqual(retargeted.sources[0].path, enrolled.sources[0].path);
  assert.throws(() => validateStore(store, retargeted.domain, retargeted.sources), /enrollment changed.*generation/i);
});

test('config resolves selected files relative to its directory and enrolls an explicit unknown identity', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runward-config-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'selected.jsonl');
  await writeFile(path, '');
  const config = join(folder, 'domain.json');
  await writeFile(config, JSON.stringify({ domain: { id: 'company', environmentId: 'laptop' }, sources: [
    { id: 'terminal', provider: 'codex', toolInstanceId: 'terminal-one', generation: 2, path: './selected.jsonl' },
  ] }));
  const command = await resolveCLI(['--config', config]);
  assert.equal(command.sources[0].path, await realpath(path));
  assert.equal(command.sources[0].fileIdentity.realpath, await realpath(path));
  assert.deepEqual(command.sources[0].identity, { alias: null, evidence: 'unknown' });
  assert.equal(command.sources[0].generation, 2);
  assert.equal(Object.hasOwn(command.sources[0], 'watchBinding'), false);
  assert.equal(command.watchSources[0].watchBinding.selectedPath, path);
  await assert.rejects(resolveCLI(['--config', config, '--domain', 'personal']), /cannot.*combine/i);
  await assert.rejects(resolveCLI(['--config', config, '--watch', `codex=${path}`]), /cannot.*combine/i);
});
