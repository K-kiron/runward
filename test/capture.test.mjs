import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('OpenHands capture preserves source timestamps and adds explicit UTC receipt time', () => {
  const event = { kind: 'MessageEvent', timestamp: '2026-01-02T09:00:00', llm_message: { content: [{ type: 'text', text: 'Synthetic event' }] } };
  const captured = spawnSync(process.execPath, ['examples/capture-openhands.mjs'], { cwd: new URL('..', import.meta.url), input: JSON.stringify(event) + '\n', encoding: 'utf8' });
  assert.equal(captured.status, 0, captured.stderr);
  const output = JSON.parse(captured.stdout);
  assert.equal(output.timestamp, event.timestamp);
  assert.deepEqual(output.llm_message, event.llm_message);
  assert.match(output.runwardObservedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('OpenHands capture reports malformed stdout without disclosing its content', () => {
  const captured = spawnSync(process.execPath, ['examples/capture-openhands.mjs'], { cwd: new URL('..', import.meta.url), input: 'private-fixture-string\n[]\n', encoding: 'utf8' });
  assert.equal(captured.status, 1);
  assert.equal(captured.stdout, '');
  assert.doesNotMatch(captured.stderr, /private-fixture-string/);
});
