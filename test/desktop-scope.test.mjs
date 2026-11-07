import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, commandsForLog } from '../lib/desktop/collector.mjs';

const allowed = 'C:/scope/Company/app';
const outside = 'C:/elsewhere';
const row = (n, { cwd, text = `message-${n}`, sessionId = 'session-a',
  timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() } = {}) => JSON.stringify({
  type: 'assistant', uuid: `row-${n}`, sessionId, ...(cwd === undefined ? {} : { cwd }),
  timestamp,
  message: { content: [{ type: 'text', text }], stop_reason: 'tool_use' },
});
const padding = label => `${label} ${'x'.repeat(300)}`;
const spans = batches => batches.flat().filter(command => command.type === 'span.upsert');
async function fixture(t, initial, { tailBytes = 2048, dispatch } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'runward-scope-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.jsonl');
  await writeFile(file, initial);
  const batches = [];
  let roots = ['C:/scope/Company'];
  let title;
  const config = { claudeScopeRoot: roots[0], tailBytes, discoveryIntervalMs: 100000,
    eventsPerSession: 100, detailChars: 400 };
  const collector = createCollector({ config,
    app: { dispatchSource: async (key, commands) => { await dispatch?.(commands); batches.push(commands); } },
    discover: async () => ({ roots, stats: {}, files: [{ path: file, sessionId: 'session-a', cwd: allowed, title }] }) });
  return { file, batches, collector, config,
    append: async text => { await appendFile(file, text); await collector.poll(); },
    setRoots: async value => { roots = value; await collector.refresh(); },
    rename: async value => { title = value; await collector.refresh(); },
  };
}

test('initial bounded Claude tails cannot restore discovery scope after a hidden revocation', async t => {
  const initial = [row(0, { cwd: outside, text: 'FOREIGN boundary' }),
    ...Array.from({ length: 12 }, (_, i) => row(i + 1, { text: padding('FOREIGN tail') }))].join('\n') + '\n';
  assert.equal(commandsForLog(initial, { provider: 'claude', path: 'synthetic', sessionId: 'session-a', cwd: allowed }, ['C:/scope/Company']).commands.length, 0);
  const view = await fixture(t, initial);
  await view.collector.poll();
  assert.equal(view.batches.length, 0, 'a truncated prefix leaves cwd inheritance unverified');
  await view.append(row(20, { cwd: allowed, text: 'RESTORED allowed' }) + '\n' + row(21, { text: 'RESTORED inherited' }) + '\n');
  assert.equal(spans(view.batches).length, 2);
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('FOREIGN')));
});

test('scope revocation survives successive overlapping windows, title changes and file touches', async t => {
  const view = await fixture(t, row(0, { cwd: allowed, text: 'ALLOWED first' }) + '\n');
  await view.collector.poll();
  await view.append(row(1, { cwd: outside, text: 'FOREIGN revoke' }) + '\n');
  for (let n = 2; n < 16; n++) await view.append(row(n, { text: padding('FOREIGN inherited') }) + '\n');
  await view.rename('Synthetic renamed session');
  await utimes(view.file, new Date(), new Date());
  await view.collector.poll();
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('FOREIGN')));
  await view.append(row(20, { cwd: allowed, text: 'ALLOWED restored' }) + '\n');
  assert.ok(spans(view.batches).some(command => command.data.detail.includes('ALLOWED restored')));
});

test('unobserved append gaps fail closed until a new explicit allowed directory', async t => {
  const view = await fixture(t, row(0, { cwd: allowed }) + '\n');
  await view.collector.poll();
  const gap = [row(1, { cwd: outside, text: 'FOREIGN gap boundary' }),
    ...Array.from({ length: 12 }, (_, i) => row(i + 2, { text: padding('FOREIGN gap tail') }))].join('\n') + '\n';
  await view.append(gap);
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('FOREIGN')));
  await view.append(row(20, { cwd: allowed, text: 'ALLOWED after gap' }) + '\n');
  assert.ok(spans(view.batches).some(command => command.data.detail.includes('ALLOWED after gap')));
});

test('a previous final allowed state cannot authorize an earlier overlapping foreign interval', async t => {
  const initial = [row(0, { cwd: outside, text: 'FOREIGN explicit' }),
    ...Array.from({ length: 5 }, (_, i) => row(i + 1, { text: padding('FOREIGN middle') })),
    row(6, { cwd: allowed, text: 'ALLOWED recovery' })].join('\n') + '\n';
  const view = await fixture(t, initial, { tailBytes: 4096 });
  await view.collector.poll();
  // Move the start of the next window into the previously observed foreign interval.
  view.config.tailBytes = 2048;
  await view.append(row(7, { text: padding('ALLOWED newer') }) + '\n');
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('FOREIGN')));
  assert.ok(spans(view.batches).some(command => command.data.detail.includes('ALLOWED newer')));
});

test('partial Unicode and CRLF revocations are applied once their record is complete', async t => {
  const initial = row(0, { cwd: allowed, text: 'ALLOWED 初始 😀' }) + '\r\n';
  const view = await fixture(t, initial);
  await view.collector.poll();
  const revocation = row(1, { cwd: outside, text: 'FOREIGN 中文 😀' });
  await view.append(revocation.slice(0, -2));
  await view.append(revocation.slice(-2) + '\r\n');
  for (let n = 2; n < 12; n++) await view.append(row(n, { text: padding('FOREIGN 后续 😀') }) + '\r\n');
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('FOREIGN')));
  await view.append(row(20, { cwd: allowed, text: 'ALLOWED 恢复 😀' }) + '\r\n');
  assert.ok(spans(view.batches).some(command => command.data.detail.includes('ALLOWED 恢复')));
});

test('scope root changes revalidate unchanged files and invalidate truncated-prefix authority', async t => {
  const view = await fixture(t, row(0, { cwd: allowed }) + '\n');
  await view.collector.poll();
  for (let n = 1; n < 12; n++) await view.append(row(n, { text: padding('Inherited allowed history') }) + '\n');
  const count = view.batches.length;
  await view.setRoots(['C:/different-scope']);
  await view.collector.poll();
  assert.equal(view.batches.length, count);
  // Restoring discovery scope alone cannot prove cwd after a discarded prefix.
  await view.setRoots(['C:/scope/Company']);
  await view.append(row(20, { text: 'UNVERIFIED after root change' }) + '\n');
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('UNVERIFIED')));
  await view.append(row(21, { cwd: allowed, text: 'ALLOWED explicit after root change' }) + '\n');
  assert.ok(spans(view.batches).some(command => command.data.detail.includes('ALLOWED explicit after root change')));
});

test('invalid UTF-8 pauses collection instead of shifting byte-addressed scope checkpoints', async t => {
  const view = await fixture(t, row(0, { cwd: allowed, text: 'ALLOWED existing' }) + '\n');
  await view.collector.poll();
  const invalid = Buffer.from(row(1, { cwd: outside, text: 'FOREIGN invalid byte' }) + '\n');
  invalid[invalid.indexOf('invalid')] = 0xff;
  await view.append(Buffer.concat([invalid, Buffer.from(row(2, { text: 'FOREIGN inherited' }) + '\n')]));
  assert.equal(view.collector.status().files[0].paused, true);
  assert.equal(view.collector.status().files[0].error, 'INVALID_TRANSCRIPT_UTF8');
  view.config.tailBytes = Buffer.byteLength(row(2, { text: 'FOREIGN inherited' }) + '\n') + 1;
  await utimes(view.file, new Date(), new Date());
  await view.collector.poll();
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('FOREIGN')));
});

test('inactive reads retain scope revocation before subsequent fresh cwd-less activity', async t => {
  const view = await fixture(t, [row(0, { cwd: allowed }), row(1, { cwd: outside })].join('\n') + '\n');
  view.config.maxSessionAgeMinutes = 1;
  await view.collector.poll();
  assert.equal(view.batches.length, 0, 'old allowed history is not imported');
  for (let n = 2; n < 14; n++) await view.append(row(n, {
    text: padding('FOREIGN fresh activity'), timestamp: new Date().toISOString(),
  }) + '\n');
  assert.equal(view.batches.length, 0, 'fresh activity cannot renew a revoked scope');
  await view.append(row(20, { cwd: allowed, text: 'ALLOWED current activity', timestamp: new Date().toISOString() }) + '\n');
  assert.ok(spans(view.batches).some(command => command.data.detail.includes('ALLOWED current')));
});

test('retryable dispatch failures cannot reset a verified revoked scope', async t => {
  let fail = false;
  const view = await fixture(t, row(0, { cwd: allowed, text: 'ALLOWED original' }) + '\n', {
    dispatch: async () => { if (fail) { fail = false; throw Object.assign(new Error('Synthetic delivery failure'), { code: 'SYNTHETIC_RETRY' }); } },
  });
  await view.collector.poll();
  await view.append(row(1, { cwd: outside, text: 'FOREIGN revocation' }) + '\n');
  fail = true;
  await view.rename('Synthetic new title');
  await view.collector.poll();
  assert.equal(view.collector.status().files[0].error, 'SYNTHETIC_RETRY');
  for (let n = 2; n < 14; n++) await view.append(row(n, { text: padding('FOREIGN after failed delivery') }) + '\n');
  assert.ok(spans(view.batches).every(command => !command.data.detail.includes('FOREIGN')));
  await view.append(row(20, { cwd: allowed, text: 'ALLOWED after delivery recovery' }) + '\n');
  assert.ok(spans(view.batches).some(command => command.data.detail.includes('ALLOWED after delivery')));
});
