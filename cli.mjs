#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from './server.mjs';
import { demoState } from './lib/demo.mjs';
import { watchTranscripts } from './lib/watch.mjs';

const help = `Runward — local operations desk for coding agents

  node cli.mjs [--port 4317] [--data path/to/state.json]
  node cli.mjs --demo
  node cli.mjs --watch "claude=/absolute/session.jsonl" --watch "codex=/absolute/rollout.jsonl"
  node cli.mjs ingest path/to/events.json [--port 4317]

Requires Node.js 22+. Binds only to 127.0.0.1. Demo data stays in memory.
Live data defaults to ~/.runward/state.json. Original transcript files are read only.
Set RUNWARD_TOKEN in the process environment to reuse a write token (16–256 characters).
Otherwise a temporary token is printed on startup. Tokens never belong in a URL or repository.
Ingest requires RUNWARD_TOKEN and a JSON command or command array. See docs/events.md.
`;

try {
  const { values, positionals } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, demo: { type: 'boolean' }, port: { type: 'string', default: '4317' },
    data: { type: 'string' }, watch: { type: 'string', multiple: true },
  }, allowPositionals: true });
  if (values.help) { console.log(help); process.exit(0); }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  if (positionals[0] === 'ingest') {
    if (positionals.length !== 2 || values.demo || values.data || values.watch) throw new Error('Use: node cli.mjs ingest events.json [--port 4317]');
    if (!process.env.RUNWARD_TOKEN) throw new Error('Set RUNWARD_TOKEN to the running server write token');
    const body = await readFile(resolve(positionals[1]), 'utf8');
    JSON.parse(body);
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RUNWARD_TOKEN}` }, body, signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    console.log(`Events accepted. Revision ${result.revision}.`);
  } else {
    if (positionals.length) throw new Error(`Unknown command.\n${help}`);
    if (values.demo && (values.data || values.watch)) throw new Error('Demo cannot use live storage or transcript files');
    const sources = (values.watch ?? []).map(value => {
      const match = /^(claude|codex)=(.+)$/.exec(value);
      if (!match) throw new Error('Use --watch "claude=/path/file.jsonl" or --watch "codex=/path/file.jsonl"');
      return { provider: match[1], path: resolve(match[2]) };
    });
    const app = await createServer({ state: values.demo ? demoState() : undefined,
      dataFile: values.demo ? null : resolve(values.data ?? `${homedir()}/.runward/state.json`),
      token: process.env.RUNWARD_TOKEN || undefined, mode: values.demo ? 'demo' : 'live' });
    const url = await app.listen(port);
    console.log(`Runward ${values.demo ? 'demo (synthetic data)' : 'live'}: ${url}\nWrite token: ${app.token}\nLocal machine only. Ctrl+C to stop.`);
    const stopWatching = watchTranscripts(sources, app.dispatch);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await stopWatching(); await app.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
