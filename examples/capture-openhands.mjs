#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { once } from 'node:events';

// OpenHands can emit timezone-naive timestamps. Preserve them and record receiver UTC separately.
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Expected an event object');
    const output = JSON.stringify({ ...event, runwardObservedAt: new Date().toISOString() }) + '\n';
    if (!process.stdout.write(output)) await once(process.stdout, 'drain');
  } catch {
    console.error('Skipped an invalid JSON event from OpenHands stdout.');
    process.exitCode = 1;
  }
}
