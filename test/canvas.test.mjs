import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createClient } from '../apps/openhands/src/client.mjs';

const appRoot = new URL('../apps/openhands/', import.meta.url);
const runFile = promisify(execFile);
const conversationId = '11111111-1111-4111-8111-111111111111';
const start = '2026-10-29T09:00:00Z';
const end = '2026-10-29T09:00:05Z';
const action = { id: 'action-one', kind: 'ActionEvent', timestamp: start, source: 'agent', tool_call_id: 'call-one', tool_name: 'terminal', action: { kind: 'TerminalAction', command: 'synthetic --check' } };
const observation = { id: 'result-one', kind: 'ObservationEvent', timestamp: end, source: 'environment', action_id: 'action-one', tool_call_id: 'call-one', observation: { kind: 'TerminalObservation', exit_code: 0, content: [{ type: 'text', text: 'Synthetic output' }] } };

function reader(pages) {
  const calls = [];
  const client = createClient(async options => {
    calls.push(options);
    assert.equal(options.method, 'GET');
    assert.ok(options.path.startsWith('/api/conversations/'));
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    assert.ok(pages.length, 'Unexpected request');
    return pages.shift();
  });
  return { client, calls };
}

test('Canvas bundle freshness accepts Windows checkout line endings and rejects stale content', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'runward-canvas-build-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const paths = ['scripts/build-canvas-app.mjs', 'lib/timestamp.mjs', 'lib/providers/openhands.mjs',
    'apps/openhands/src/client.mjs', 'apps/openhands/src/style.mjs', 'apps/openhands/src/view.mjs',
    'apps/openhands/src/entry.mjs', 'apps/openhands/extension.js'];
  for (const path of paths) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const target = join(fixture, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source.replace(/\r?\n/g, '\r\n'));
  }
  const script = join(fixture, 'scripts/build-canvas-app.mjs');
  await runFile(process.execPath, [script, '--check']);
  await writeFile(join(fixture, 'apps/openhands/extension.js'), '// stale bundle\r\n');
  await assert.rejects(runFile(process.execPath, [script, '--check']), /out of date/);
});

test('Canvas package can be installed from its own repository directory', async () => {
  const source = await readFile(new URL('canvas-extension.json', appRoot), 'utf8').catch(() => null);
  assert.ok(source, 'An installable app needs a manifest in apps/openhands.');
  const manifest = JSON.parse(source);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.name, 'runward');
  assert.equal(manifest.entrypoint, 'extension.js');
  assert.equal(manifest.contributes.pages[0].id, 'timeline');
  const bundle = await readFile(new URL(manifest.entrypoint, appRoot), 'utf8');
  const { activate } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`);
  const registrations = [];
  let unregistered = false;
  const dispose = activate({ apiVersion: '1', backend: { id: 'synthetic' }, agentServer: { request: async () => ({}) },
    registerPage(id, mount) { registrations.push({ id, mount }); return () => { unregistered = true; }; } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'timeline');
  assert.equal(typeof registrations[0].mount, 'function');
  dispose();
  assert.equal(unregistered, true);
  assert.throws(() => activate({ apiVersion: '2' }), /API 1/);
});

test('Canvas reads paginated conversation metadata without retaining agent configuration', async () => {
  const { client, calls } = reader([
    { items: [{ id: conversationId, title: 'Synthetic project', execution_status: 'running', agent: { api_key: 'synthetic-secret' } }], next_page_id: 'metadata-cursor' },
    { items: [{ id: '22222222-2222-4222-8222-222222222222', title: 'Another session', execution_status: 'idle' }], next_page_id: null },
  ]);
  const result = await client.listConversations();
  assert.deepEqual(result.conversations[0], { id: conversationId, title: 'Synthetic project', status: 'running' });
  assert.equal(result.conversations.length, 2);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  assert.equal(new URL(calls[0].path, 'http://fixture').searchParams.get('sort_order'), 'CREATED_AT_DESC');
  assert.equal(new URL(calls[1].path, 'http://fixture').searchParams.get('page_id'), 'metadata-cursor');
});

test('Canvas reads newest event pages and reuses action/observation pairing on a shared clock', async () => {
  const { client, calls } = reader([
    { items: [observation], next_page_id: 'cursor+with/slash=' },
    { items: [action], next_page_id: null },
  ]);
  const result = await client.readConversation(conversationId);
  assert.equal(result.eventCount, 2);
  const tool = result.spans.find(span => span.kind === 'tool');
  assert.equal(tool.startedAt, '2026-10-29T09:00:00.000Z');
  assert.equal(tool.endedAt, '2026-10-29T09:00:05.000Z');
  assert.match(tool.detail, /synthetic --check/);
  assert.match(tool.detail, /Synthetic output/);
  assert.equal(result.timingBasis, 'reported');
  assert.equal(result.status, 'unknown');
  assert.equal(result.untimedEvents.length, 0);
  assert.equal(new URL(calls[0].path, 'http://fixture').pathname, `/api/conversations/${conversationId}/events/search`);
  assert.equal(new URL(calls[0].path, 'http://fixture').searchParams.get('sort_order'), 'TIMESTAMP_DESC');
  assert.equal(new URL(calls[1].path, 'http://fixture').searchParams.get('page_id'), 'cursor+with/slash=');
});

test('naive server timestamps remain untimed until the user supplies an offset', async () => {
  const rows = [{ ...observation, timestamp: '2026-10-29T09:00:05' }, { ...action, timestamp: '2026-10-29T09:00:00' }];
  const original = JSON.stringify(rows);
  const { client } = reader([{ items: rows, next_page_id: null }]);
  const result = await client.readConversation(conversationId);
  assert.equal(result.spans.length, 0);
  assert.equal(result.untimedEvents.length, 2);
  assert.equal(result.untimedEvents[0].rawTimestamp, '2026-10-29T09:00:00');
  assert.equal(result.timingBasis, 'unknown');
  assert.equal(JSON.stringify(rows), original);
  assert.ok(result.warnings.some(warning => /timezone|offset/i.test(warning)));
});

test('explicit fixed offsets convert naive events without replacing timezone-bearing producer times', async () => {
  const rows = [observation, { ...action, timestamp: '2026-10-29T05:00:00' }];
  const original = JSON.stringify(rows);
  const { client } = reader([{ items: rows, next_page_id: null }]);
  const result = await client.readConversation(conversationId, { utcOffset: '-04:00' });
  const tool = result.spans.find(span => span.kind === 'tool');
  assert.equal(tool.startedAt, '2026-10-29T09:00:00.000Z');
  assert.equal(tool.endedAt, '2026-10-29T09:00:05.000Z');
  assert.equal(result.timingBasis, 'fixed-offset');
  assert.equal(JSON.stringify(rows), original);
  assert.ok(result.warnings.some(warning => /user.supplied|fixed.offset/i.test(warning)));
});

test('invalid offsets and unsafe conversation paths are rejected before any request', async () => {
  const { client, calls } = reader([]);
  for (const utcOffset of ['UTC', 'Z', '+15:00', '+14:01', '-14:01', '+05:60', '04:00']) {
    await assert.rejects(client.readConversation(conversationId, { utcOffset }), /UTC offset/);
  }
  for (const id of ['../server_info', 'a/b', '', 'https://untrusted.example']) await assert.rejects(client.readConversation(id), /conversation ID/i);
  assert.equal(calls.length, 0);
});

test('invalid calendar dates never acquire invented timestamps through a supplied offset', async () => {
  const { client } = reader([{ items: [{ ...action, timestamp: '2026-02-30T09:00:00' }], next_page_id: null }]);
  const result = await client.readConversation(conversationId, { utcOffset: '+00:00' });
  assert.equal(result.spans.length, 0);
  assert.equal(result.untimedEvents.length, 1);
});

test('repeated cursors and malformed pages fail closed instead of looping or leaking responses', async () => {
  const repeated = reader([{ items: [action], next_page_id: 'same' }, { items: [action], next_page_id: 'same' }]);
  await assert.rejects(repeated.client.readConversation(conversationId), /cursor/i);
  assert.equal(repeated.calls.length, 2);
  for (const body of [null, [], { items: {} }, { items: [], next_page_id: {} }]) {
    const { client } = reader([body]);
    await assert.rejects(client.readConversation(conversationId), /invalid|malformed/i);
  }
  const client = createClient(async () => { throw new Error('synthetic-secret-in-upstream-error'); });
  await assert.rejects(client.readConversation(conversationId), error => !error.message.includes('synthetic-secret') && /backend|server/i.test(error.message));
});

test('disposing a page stops pagination after an in-flight request settles', async () => {
  let active = true;
  let calls = 0;
  const client = createClient(async () => {
    calls++;
    active = false;
    return { items: [action], next_page_id: 'more' };
  });
  await assert.rejects(client.readConversation(conversationId, { isActive: () => active }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('bounded history retains only the newest window and reports the missing prefix', async () => {
  let pages = 0;
  const client = createClient(async () => ({ items: Array.from({ length: 100 }, (_, index) => ({ ...observation, id: `synthetic-${pages}-${index}`, tool_call_id: `call-${pages}-${index}` })), next_page_id: `page-${++pages}` }));
  const result = await client.readConversation(conversationId);
  assert.equal(pages, 20);
  assert.equal(result.eventCount, 2000);
  assert.ok(result.warnings.some(warning => /older|limit/i.test(warning)));
  assert.ok(result.spans.every(span => span.startedAt === span.endedAt));
});

test('Canvas retains explicit failures and never turns completion or output prose into passed runs', async () => {
  const failed = { ...observation, observation: { kind: 'TerminalObservation', exit_code: 3, content: [{ type: 'text', text: 'tests passed (synthetic prose)' }] } };
  const state = { id: 'state', kind: 'ConversationStateUpdateEvent', timestamp: end, key: 'full_state', value: { execution_status: 'finished', agent: { api_key: 'synthetic-secret' } } };
  const { client } = reader([{ items: [failed, state, action], next_page_id: null }]);
  const result = await client.readConversation(conversationId);
  assert.equal(result.spans.find(span => span.label === 'terminal').kind, 'error');
  assert.equal(result.status, 'idle');
  assert.equal(result.runs, undefined);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});
