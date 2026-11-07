#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from '../server.mjs';
import { normalizeDomain } from '../lib/domain.mjs';
import { createCollector } from '../lib/desktop/collector.mjs';
import { discoverClaude } from '../lib/desktop/claude-discovery.mjs';

const pathKeys = ['codexSessionsRoot', 'codexIndexPath', 'codexTranscript', 'claudeScopeRoot',
  'claudeProjectsRoot', 'claudeRegistryRoot', 'claudeRepoRoot'];
const limits = {
  port: [4317, 1, 65535], pollIntervalMs: [2000, 100, 60000],
  discoveryIntervalMs: [10000, 100, 3600000], recentHours: [24, 1, 720],
  maxSessionAgeMinutes: [60, 1, 1440], tailBytes: [4194304, 1024, 33554432],
  eventsPerSession: [100, 1, 500], detailChars: [400, 64, 12000],
};

export function desktopConfig(value, baseDirectory = process.cwd()) {
  const allowed = new Set(['domain', 'codexScopeRoots', ...pathKeys, ...Object.keys(limits)]);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('Desktop config contains unsupported fields');
  }
  const config = { domain: normalizeDomain(value.domain) };
  for (const key of pathKeys) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 4096) throw new Error(`Invalid ${key}`);
    config[key] = resolve(baseDirectory, value[key]);
  }
  if (value.codexScopeRoots !== undefined) {
    if (!Array.isArray(value.codexScopeRoots) || !value.codexScopeRoots.length || value.codexScopeRoots.length > 100
        || value.codexScopeRoots.some(root => typeof root !== 'string' || !root.trim() || root.length > 4096)) {
      throw new Error('codexScopeRoots must contain explicit workspace directories');
    }
    config.codexScopeRoots = value.codexScopeRoots.map(root => resolve(baseDirectory, root));
  }
  if (!!config.codexSessionsRoot !== !!config.codexScopeRoots) throw new Error('Set both codexSessionsRoot and codexScopeRoots');
  if (config.codexIndexPath && !config.codexSessionsRoot && !config.codexTranscript) throw new Error('codexIndexPath requires a Codex source');
  if (!!config.claudeScopeRoot !== !!config.claudeProjectsRoot) throw new Error('Set both claudeScopeRoot and claudeProjectsRoot');
  if ((config.claudeRegistryRoot || config.claudeRepoRoot) && !config.claudeScopeRoot) throw new Error('Claude metadata paths require claudeScopeRoot and claudeProjectsRoot');
  if (!config.codexSessionsRoot && !config.codexTranscript && !config.claudeScopeRoot) throw new Error('Select at least one desktop transcript source');
  for (const [key, [fallback, min, max]] of Object.entries(limits)) {
    const number = value[key] ?? fallback;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${key}: expected an integer from ${min} to ${max}`);
    config[key] = number;
  }
  return config;
}

export async function runDesktopOverview(config, { env = process.env, log = console.log,
  report = console.error, listenPort = config.port } = {}) {
  const providers = [config.codexSessionsRoot || config.codexTranscript ? 'codex' : null,
    config.claudeScopeRoot ? 'claude' : null].filter(Boolean);
  const app = await createServer({ domain: config.domain, mode: 'live', sources: providers.map(provider => ({
    id: `desktop-${provider}`, provider, toolInstanceId: 'scoped-desktop-collector', generation: 1,
  })), tokens: { read: env.RUNWARD_READ_TOKEN || undefined, action: env.RUNWARD_TOKEN || undefined } });
  const collector = createCollector({ config, app, discover: discoverClaude });
  let stopped = false;
  let timer;
  let running = Promise.resolve();
  const stop = async () => {
    stopped = true;
    clearTimeout(timer);
    await running.catch(() => {});
    await app.close();
  };
  const tick = () => {
    running = collector.poll().catch(() => report('Desktop discovery failed; check the explicitly configured directories.'))
      .finally(() => { if (!stopped) { timer = setTimeout(tick, config.pollIntervalMs); timer.unref(); } });
  };
  try {
    running = collector.poll();
    await running;
    const url = await app.listen(listenPort);
    log(`Runward desktop overview ${config.domain.id}/${config.domain.environmentId}: ${url}`);
    log(`Read token: ${app.tokens.read}\nAction token: ${app.tokens.action}`);
    log('Activity stays in memory. Local machine only. Ctrl+C to stop.');
    timer = setTimeout(tick, config.pollIntervalMs);
    timer.unref();
    return { app, collector, url, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
      console.log('Usage: node scripts/desktop-overview.mjs --config /path/to/desktop.json\nSee docs/desktop.md for explicit source scopes and limits.');
    } else {
      if (!values.config) throw new Error('Desktop collection requires --config with explicit transcript directories and workspace scopes');
      const path = resolve(values.config);
      const config = desktopConfig(JSON.parse(await readFile(path, 'utf8')), dirname(path));
      const runtime = await runDesktopOverview(config);
      const stop = () => { void runtime.stop(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
