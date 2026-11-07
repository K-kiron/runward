import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseTranscript } from '../adapters.mjs';
import { isCwdAllowed } from './scope.mjs';
import { readCodexTitle, sanitizeTitle } from './titles.mjs';
import { discoverCodex } from './codex-discovery.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const paused = code => Object.assign(new Error(code), { code, sourcePaused: true });
const pathKey = value => /^[a-z]:[\\/]|^\\\\/i.test(value)
  ? value.replaceAll('\\', '/').toLowerCase() : value;

export async function readBoundedLog(path, previous, { tailBytes = 4 * 1024 * 1024, full = false } = {}) {
  const canonical = await realpath(path);
  const file = await open(canonical, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || !before.ino) throw paused('UNSUPPORTED_FILE_IDENTITY');
    if (previous && (canonical !== previous.canonical || !sameFile(before, previous) || before.size < previous.size)) {
      throw paused('SOURCE_REPLACED_OR_TRUNCATED');
    }
    if (previous) {
      const anchor = Buffer.alloc(previous.anchorLength);
      const { bytesRead } = await file.read(anchor, 0, anchor.length, previous.anchorStart);
      if (bytesRead !== anchor.length || hash(anchor) !== previous.anchorHash) throw paused('SOURCE_ANCHOR_CHANGED');
    }
    if (full && before.size > 32 * 1024 * 1024) throw paused('CODEX_LOG_EXCEEDS_32_MIB');
    const start = full ? 0 : Math.max(0, before.size - tailBytes);
    const bytes = Buffer.alloc(before.size - start);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!result.bytesRead) throw paused('SOURCE_CHANGED_DURING_READ');
      offset += result.bytesRead;
    }
    const after = await file.stat();
    const selected = await stat(path);
    if (!sameFile(before, after) || !sameFile(before, selected) || after.size < before.size || (await realpath(path)) !== canonical) {
      throw paused('SOURCE_CHANGED_DURING_READ');
    }
    const anchorLength = Math.min(bytes.length, 65536);
    const binding = { canonical, dev: before.dev, ino: before.ino, size: before.size,
      anchorStart: before.size - anchorLength, anchorLength, anchorHash: hash(bytes.subarray(bytes.length - anchorLength)) };
    const first = start ? bytes.indexOf(10) + 1 : 0;
    const last = bytes.lastIndexOf(10);
    // A bounded tail may start or end inside a JSON record. Never import fragments.
    const complete = last >= first && (!start || first > 0);
    const textStart = start + first;
    const completeEnd = complete ? start + last + 1 : textStart;
    let text = '';
    try {
      // Replacement decoding changes byte lengths and would invalidate scope offsets.
      if (complete) text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(first, last + 1));
    } catch { throw paused('INVALID_TRANSCRIPT_UTF8'); }
    return { text, binding, truncatedPrefix: start > 0, textStart, completeEnd };
  } finally { await file.close(); }
}

export function commandsForLog(text, source, roots, { eventsPerSession = 100, detailChars = 400,
  scopeProof, truncatedPrefix = false, textStart = 0, completeEnd = textStart + Buffer.byteLength(text) } = {}) {
  let rejectedRows = 0;
  let nextScopeProof;
  if (source.provider === 'codex' && source.scoped) {
    let metadata;
    try { metadata = JSON.parse(text.split('\n')[0]); } catch { /* Fail closed on an unverified header. */ }
    const value = metadata?.payload;
    if (metadata?.type !== 'session_meta' || value?.id !== source.sessionId || !isCwdAllowed(value?.cwd, roots)
        || value.parent_thread_id || value.forked_from_id || metadata.parent_thread_id || metadata.forked_from_id
        || value.source === 'subagent'
        || (value.source && typeof value.source === 'object' && Object.hasOwn(value.source, 'subagent'))) {
      return { commands: [], rejectedRows: 1, warningCount: 1 };
    }
  }
  if (source.provider === 'claude') {
    // A previous window proves scope only at positions it actually observed.
    // Its final state cannot authorize earlier overlapping rows or unseen gaps.
    const context = JSON.stringify([source.sessionId, roots]);
    const overlaps = scopeProof?.context === context
      && scopeProof.textStart <= textStart && textStart <= scopeProof.completeEnd;
    let scoped = !truncatedPrefix && textStart === 0 && isCwdAllowed(source.cwd, roots);
    if (overlaps) {
      scoped = scopeProof.initialScoped;
      for (const transition of scopeProof.transitions) {
        if (transition.offset > textStart) break;
        scoped = transition.scoped;
      }
    }
    nextScopeProof = { context, textStart, completeEnd, initialScoped: scoped, transitions: [] };
    let offset = textStart;
    const lines = text.split('\n');
    text = lines.flatMap((line, index) => {
      offset += Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
      const setScope = value => {
        if (scoped !== value) nextScopeProof.transitions.push({ offset, scoped: value });
        scoped = value;
      };
      if (!line.trim()) return [];
      let row;
      try { row = JSON.parse(line); } catch { setScope(false); return []; }
      const request = row?.type === 'api-request' && typeof row.id === 'string' && row.id.trim();
      const message = ['user', 'assistant'].includes(row?.type) && row.message
        && typeof row.message === 'object' && !Array.isArray(row.message);
      if (!request && !message) return [];
      if (request && (row.isApiErrorMessage === true || row.isMeta === true
          || row.isVisibleInTranscriptOnly === true || row.isCompactSummary === true)) return [];
      if (row.sessionId !== source.sessionId) { setScope(false); rejectedRows++; return []; }
      if (row.cwd !== undefined) setScope(isCwdAllowed(row.cwd, roots));
      if (!scoped) { rejectedRows++; return []; }
      if (!request) return [line];
      // Requests contain full prompt parameters; only lifecycle metadata reaches the parser.
      const { type, id, sessionId, timestamp, cwd } = row;
      return [JSON.stringify({ type, id, sessionId, timestamp, ...(cwd === undefined ? {} : { cwd }) })];
    }).join('\n');
  }
  const parsed = parseTranscript(text, { provider: source.provider, sourceId: source.path });
  const agents = parsed.commands.filter(command => command.type === 'agent.upsert');
  for (const command of agents) {
    command.data.name = sanitizeTitle(source.title)
      || sanitizeTitle(`${source.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${command.data.project}`);
  }
  const allSpans = parsed.commands.filter(command => command.type === 'span.upsert');
  const ordinary = new Set(allSpans.filter(command => command.data.kind !== 'attention')
    .slice(-eventsPerSession).map(command => command.data.id));
  // Input requests and their old closure updates are lifecycle records, not
  // expendable preview history. Reuse the parser's retention guarantees.
  const spans = allSpans.filter(command => command.data.kind === 'attention' || ordinary.has(command.data.id));
  const shortened = '\n[Local preview shortened; see original transcript]';
  for (const command of spans) if (command.data.detail?.length > detailChars) {
    command.data.detail = `${command.data.detail.slice(0, Math.max(0, detailChars - shortened.length))}${shortened}`.slice(0, detailChars);
  }
  return { commands: [...agents, ...spans], rejectedRows, warningCount: parsed.warnings.length, scopeProof: nextScopeProof };
}

export function createCollector({ config, app, discover, discoverCodex: discoverCodexFiles = discoverCodex, now = () => Date.now() }) {
  const known = new Map();
  let roots = config.claudeScopeRoot ? [config.claudeScopeRoot] : [];
  let discovery = null;
  let codexDiscovery = null;
  let files = [];
  let lastDiscovery = 0;
  const refresh = async () => {
    discovery = config.claudeScopeRoot ? await discover({ scopeRoot: config.claudeScopeRoot,
      repoRoot: config.claudeRepoRoot, projectsRoot: config.claudeProjectsRoot, registryRoot: config.claudeRegistryRoot,
      recentHours: config.recentHours, now: now() }) : { roots: [], files: [], stats: {} };
    roots = discovery.roots;
    const codexId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(config.codexTranscript ?? '')?.[1] ?? null;
    const codexTitle = codexId && config.codexIndexPath ? await readCodexTitle(codexId, { indexPath: config.codexIndexPath }) : null;
    codexDiscovery = config.codexSessionsRoot && config.codexScopeRoots?.length
      ? await discoverCodexFiles({ sessionsRoot: config.codexSessionsRoot, scopeRoots: config.codexScopeRoots,
        indexPath: config.codexIndexPath, recentHours: config.recentHours, now: now() }) : null;
    // Discovery supersedes the pinned entry for the same path and revalidates its scope.
    const codexFiles = new Map(config.codexTranscript ? [[pathKey(config.codexTranscript),
      { path: config.codexTranscript, provider: 'codex', sessionId: codexId, title: codexTitle }]] : []);
    for (const file of codexDiscovery?.files ?? []) codexFiles.set(pathKey(file.path), { ...file, provider: 'codex', scoped: true });
    files = [...codexFiles.values(),
      ...discovery.files.map(file => ({ ...file, provider: 'claude' }))];
    lastDiscovery = now();
  };
  const poll = async () => {
    if (!lastDiscovery || now() - lastDiscovery >= config.discoveryIntervalMs) await refresh();
    for (const source of files) {
      let state = known.get(source.path);
      if (!state) { state = { provider: source.provider, path: source.path, sessionId: source.sessionId, acknowledged: new Map() }; known.set(source.path, state); }
      if (state.paused) continue;
      try {
        const info = await stat(source.path);
        const sourceRoots = source.provider === 'codex' ? config.codexScopeRoots ?? [] : roots;
        const signature = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs,
          source.title ?? null, source.sessionId, source.cwd, source.scoped, sourceRoots]);
        if (state.signature === signature) continue;
        const cutoff = config.maxSessionAgeMinutes ? now() - config.maxSessionAgeMinutes * 60_000 : -Infinity;
        // Windows can leave mtime unchanged while an open writer appends.
        // File size detects growth; only producer timestamps decide inactivity.
        const read = await readBoundedLog(source.path, state.binding, { tailBytes: config.tailBytes, full: source.provider === 'codex' });
        const parsed = commandsForLog(read.text, source, sourceRoots, { ...config,
          truncatedPrefix: read.truncatedPrefix, textStart: read.textStart, completeEnd: read.completeEnd, scopeProof: state.scopeProof });
        // File validation and scope evidence are independent of delivery. Keep
        // them across inactive reads and retryable dispatch failures as well.
        state.binding = read.binding;
        state.scopeProof = parsed.scopeProof;
        const activityTimes = parsed.commands.flatMap(command => command.type === 'agent.upsert'
          ? [command.data.lastSeen] : [command.data.startedAt, command.data.endedAt])
          .map(value => typeof value === 'string' ? Date.parse(value) : NaN).filter(value => Number.isFinite(value) && value <= now());
        const latestActivity = activityTimes.length ? Math.max(...activityTimes) : null;
        if (latestActivity !== null && latestActivity < cutoff) {
          Object.assign(state, { binding: read.binding, signature, skipped: 'inactive', latestActivityAt: new Date(latestActivity).toISOString(),
            previewEventCount: 0, error: null });
          continue;
        }
        if (latestActivity === null && config.maxSessionAgeMinutes && parsed.commands.length) {
          Object.assign(state, { binding: read.binding, signature, skipped: 'no-valid-activity-time', previewEventCount: 0, error: null });
          continue;
        }
        const pending = parsed.commands.map(command => ({ command, key: `${command.type}:${command.data.id}`, fingerprint: hash(JSON.stringify(command)) }))
          .filter(item => state.acknowledged.get(item.key) !== item.fingerprint);
        for (let index = 0; index < pending.length; index += 1000) {
          const batch = pending.slice(index, index + 1000);
          await app.dispatchSource(source.provider === 'codex' ? 'desktop-codex:1' : 'desktop-claude:1', batch.map(item => item.command));
          for (const item of batch) state.acknowledged.set(item.key, item.fingerprint);
        }
        state.acknowledged = new Map(parsed.commands.map(command => [`${command.type}:${command.data.id}`, hash(JSON.stringify(command))]));
        Object.assign(state, { binding: read.binding, signature, previewEventCount: parsed.commands.filter(command => command.type === 'span.upsert').length,
          warningCount: parsed.warningCount, rejectedRows: parsed.rejectedRows, truncatedPrefix: read.truncatedPrefix,
          latestActivityAt: latestActivity === null ? null : new Date(latestActivity).toISOString(), skipped: null,
          lastReadAt: new Date(now()).toISOString(), error: parsed.commands.length ? null : 'NO_SUPPORTED_ROWS_IN_BOUNDED_TAIL' });
      } catch (error) {
        state.error = error.code ?? 'COLLECTOR_READ_OR_IMPORT_FAILED';
        if (error.sourcePaused || error.code === 'SOURCE_REVOKED') state.paused = true;
      }
    }
  };
  return { poll, refresh, status: () => ({ lastDiscoveryAt: lastDiscovery ? new Date(lastDiscovery).toISOString() : null,
    discoveryStats: discovery?.stats ?? {}, codexDiscoveryStats: codexDiscovery?.stats ?? {}, roots,
    selectedCodexFiles: files.filter(file => file.provider === 'codex').length, selectedClaudeFiles: files.filter(file => file.provider === 'claude').length,
    files: files.map(file => {
      const state = known.get(file.path);
      return { path: file.path, provider: file.provider, sessionId: file.sessionId, titleSource: file.title ? 'platform' : 'directory', previewEventCount: state?.previewEventCount ?? 0,
        warningCount: state?.warningCount ?? 0, rejectedRows: state?.rejectedRows ?? 0, truncatedPrefix: state?.truncatedPrefix ?? false,
        lastReadAt: state?.lastReadAt ?? null, latestActivityAt: state?.latestActivityAt ?? null, skipped: state?.skipped ?? null,
        paused: state?.paused ?? false, error: state?.error ?? null };
    }) }) };
}
