#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { demoState } from './lib/demo.mjs';
import { watchTranscripts } from './lib/watch.mjs';
import { TRANSCRIPT_PROVIDERS } from './lib/adapters.mjs';
import { normalizeDomain, normalizeSource, sourceKey } from './lib/domain.mjs';
import { enrollTranscript } from './lib/enrollment.mjs';

export const help = `Runward — local operations desk for coding agents

  node cli.mjs --domain personal --environment laptop [--port 4317]
  node cli.mjs --config path/to/domain.json [--data path/to/state.json]
  node cli.mjs --domain personal --environment laptop --watch "codex=/absolute/rollout.jsonl"
  node cli.mjs --demo
  node cli.mjs ingest path/to/events.json [--port 4317]
  node cli.mjs purge SOURCE_ID [--port 4317]
  node cli.mjs migrate legacy.json --agent AGENT_ID --domain DOMAIN --environment ENV --source-id SOURCE --data NEW_PATH

Requires Node.js 22+. Binds only to 127.0.0.1. Demo data stays in memory.
Live mode requires a domain and environment, and defaults to
~/.runward/domains/<domain>/<environment>/state.json. Legacy storage is never loaded implicitly.
Transcript providers: ${TRANSCRIPT_PROVIDERS.join(', ')}. Selected files are read only.
Read, operator-action, and source-ingest capabilities are separate and printed at startup.
RUNWARD_READ_TOKEN and RUNWARD_TOKEN can reuse matching read and action capabilities.
Ingest requires RUNWARD_INGEST_TOKEN; purge requires RUNWARD_TOKEN.
Tokens never belong in a URL, config file, transcript, or repository.
After purge or file replacement, remove the source or explicitly enroll a new generation in --config.
`;

export async function resolveCLI(argv, { cwd = process.cwd(), home = homedir() } = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: {
    help: { type: 'boolean', short: 'h' }, demo: { type: 'boolean' }, port: { type: 'string', default: '4317' },
    data: { type: 'string' }, watch: { type: 'string', multiple: true }, config: { type: 'string' },
    domain: { type: 'string' }, environment: { type: 'string' },
    agent: { type: 'string', multiple: true }, 'source-id': { type: 'string' },
  }, allowPositionals: true });
  if (values.help) return { command: 'help' };
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  if (['ingest', 'purge'].includes(positionals[0])) {
    if (positionals.length !== 2) throw new Error(`Use: node cli.mjs ${positionals[0]} ${positionals[0] === 'ingest' ? 'events.json' : 'SOURCE_ID'} [--port 4317]`);
    if (Object.keys(values).some(key => key !== 'port' && values[key] !== undefined)) throw new Error('Cannot combine ingest or purge with server configuration flags');
    if (positionals[0] === 'ingest') return { command: 'ingest', port, input: resolve(cwd, positionals[1]) };
    const source = normalizeSource({ id: positionals[1], provider: 'custom', toolInstanceId: 'event-api', generation: 1 });
    return { command: 'purge', port, sourceId: source.id };
  }
  if (positionals[0] === 'migrate') {
    if (values.demo || values.watch || values.config) throw new Error('Cannot combine migrate with --demo, --watch, or --config');
    if (positionals.length !== 2 || !values.agent?.length) throw new Error('Migration requires a legacy file and explicit --agent selections');
    if (!values.domain || !values.environment || !values['source-id'] || !values.data) throw new Error('Migration requires --domain, --environment, --source-id, and --data NEW_PATH');
    const input = resolve(cwd, positionals[1]);
    const dataFile = resolve(cwd, values.data);
    if (input === dataFile) throw new Error('Migration input and output must be different files');
    return { command: 'migrate', input, dataFile, agentIds: values.agent,
      domain: normalizeDomain({ id: values.domain, environmentId: values.environment }),
      source: normalizeSource({ id: values['source-id'], provider: 'custom', toolInstanceId: 'legacy-import', generation: 1 }) };
  }
  if (positionals.length) throw new Error(`Unknown command.\n${help}`);
  if (values.demo) {
    if (values.data || values.watch || values.config || values.domain || values.environment || values.agent || values['source-id']) throw new Error('Demo cannot use live storage, domain configuration, or transcript files');
    return { command: 'serve', mode: 'demo', port, dataFile: null, sources: [], watchSources: [] };
  }
  if (values.agent || values['source-id']) throw new Error('--agent and --source-id are only used by migrate');
  let domain;
  let selected = [];
  let baseDirectory = cwd;
  if (values.config) {
    if (values.domain || values.environment || values.watch) throw new Error('Cannot combine --config with --domain, --environment, or --watch');
    const configPath = resolve(cwd, values.config);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).some(key => !['domain', 'sources'].includes(key)) || !Array.isArray(config.sources)) {
      throw new Error('Config must contain only domain and sources');
    }
    domain = normalizeDomain(config.domain);
    selected = config.sources.map(normalizeSource);
    baseDirectory = dirname(configPath);
  } else {
    if (!values.domain || !values.environment) throw new Error('Live mode requires --domain and --environment, or --config');
    domain = normalizeDomain({ id: values.domain, environmentId: values.environment });
    selected = (values.watch ?? []).map(value => {
      const match = /^([^=]+)=(.+)$/.exec(value);
      if (!match || !TRANSCRIPT_PROVIDERS.includes(match[1])) throw new Error(`Use --watch "provider=/path/file"; providers: ${TRANSCRIPT_PROVIDERS.join(', ')}`);
      return { provider: match[1], path: match[2], generation: 1 };
    });
  }
  const sources = [];
  const watchSources = [];
  const sourceIds = new Set();
  const paths = new Set();
  if (selected.length > 1000) throw new Error('At most 1000 sources can be enrolled');
  for (const source of selected) {
    let descriptor = source;
    if (source.path) {
      if (!TRANSCRIPT_PROVIDERS.includes(source.provider)) throw new Error(`Unsupported transcript provider: ${source.provider}`);
      const enrolled = await enrollTranscript(source, baseDirectory);
      if (paths.has(enrolled.path)) throw new Error('A transcript path can be enrolled only once per configuration');
      paths.add(enrolled.path);
      if (!enrolled.id) {
        const hash = createHash('sha256').update(JSON.stringify([source.provider, enrolled.watchBinding.selectedPath])).digest('hex').slice(0, 20);
        enrolled.id = `file-${hash}`;
        enrolled.toolInstanceId = `selected-${hash}`;
      }
      const { watchBinding, ...persisted } = enrolled;
      descriptor = normalizeSource(persisted);
      watchSources.push({ ...descriptor, watchBinding });
    }
    if (sourceIds.has(descriptor.id)) throw new Error('Config must select only one generation for each source id');
    sourceIds.add(descriptor.id);
    sources.push(descriptor);
  }
  return { command: 'serve', mode: 'live', port, domain, sources, watchSources,
    dataFile: resolve(cwd, values.data ?? join(home, '.runward', 'domains', domain.id, domain.environmentId, 'state.json')) };
}

export async function runCLI(argv, { env = process.env, log = console.log, ...paths } = {}) {
  const command = await resolveCLI(argv, paths);
  if (command.command === 'help') { log(help); return; }
  if (command.command === 'ingest' || command.command === 'purge') {
    const variable = command.command === 'ingest' ? 'RUNWARD_INGEST_TOKEN' : 'RUNWARD_TOKEN';
    if (!env[variable]) throw new Error(`Set ${variable} to the running server ${command.command === 'ingest' ? 'source ingest' : 'action'} token`);
    const body = command.command === 'ingest' ? await readFile(command.input, 'utf8') : '{}';
    JSON.parse(body);
    const path = command.command === 'ingest' ? '/api/events' : `/api/sources/${encodeURIComponent(command.sourceId)}/purge`;
    const response = await fetch(`http://127.0.0.1:${command.port}${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${env[variable]}`,
    }, body, signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
    log(`${command.command === 'ingest' ? 'Events accepted' : 'Source purged and revoked'}. Revision ${result.revision}.`);
    return result;
  }
  if (command.command === 'migrate') {
    const { migrateLegacy } = await import('./lib/domain.mjs');
    const { acquireStateLock, saveState } = await import('./server.mjs');
    const release = await acquireStateLock(command.dataFile);
    try {
      const raw = JSON.parse(await readFile(command.input, 'utf8'));
      const store = migrateLegacy(raw, { domain: command.domain, source: command.source, agentIds: command.agentIds });
      await saveState(release.path, store, { exclusive: true });
      log(`Migrated ${store.state.agents.length} selected agent(s) to ${command.domain.id}/${command.domain.environmentId}. Original file preserved.`);
      return store;
    } finally { await release(); }
  }
  const { createServer } = await import('./server.mjs');
  const app = await createServer({ domain: command.domain, sources: command.sources,
    state: command.mode === 'demo' ? demoState() : undefined, dataFile: command.dataFile, mode: command.mode,
    tokens: { read: env.RUNWARD_READ_TOKEN || undefined, action: env.RUNWARD_TOKEN || undefined } });
  let stopWatching = async () => {};
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await stopWatching();
    await app.close();
  };
  try {
    const url = await app.listen(command.port);
    log(`Runward ${command.mode === 'demo' ? 'demo (synthetic data)' : `live ${command.domain.id}/${command.domain.environmentId}`}: ${url}`);
    log(`Read token: ${app.tokens.read}\nAction token: ${app.tokens.action}`);
    for (const [key, token] of Object.entries(app.tokens.ingest)) log(`Ingest token [${key}]: ${token}`);
    log('Local machine only. Ctrl+C to stop.');
    const keys = new Map(command.sources.map(source => [source.id, sourceKey(source)]));
    stopWatching = watchTranscripts(command.watchSources, (commands, source) => app.dispatchSource(keys.get(source.id), commands));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return { app, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCLI(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
