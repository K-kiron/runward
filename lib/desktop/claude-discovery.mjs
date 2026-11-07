import { readdir, readFile, stat, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeTitle } from './titles.mjs';
import { isCwdAllowed } from './scope.mjs';

const run = promisify(execFile);
const registryCache = new Map();
const tailActivityCache = new Map();
const TAIL_CACHE_LIMIT = 4096;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoded = cwd => cwd.replace(/[^A-Za-z0-9]/g, '-');
const absolute = value => typeof value === 'string'
  && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));

async function entries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function registryFiles(directory) {
  const result = [];
  for (const item of await entries(directory)) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await registryFiles(full));
    else if (item.isFile() && /^local_.*\.json$/i.test(item.name)) result.push(full);
  }
  return result;
}

function eventTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+month - 1];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

async function recentTailActivity(candidate, selected, roots, now) {
  // Windows can leave the mtime unchanged while a long-lived writer appends.
  // Only an already scoped candidate gets this bounded fallback; retain no text.
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const file = await open(candidate.path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || !sameFile(before, selected)) return { activity: null, cacheable: false };
    const start = Math.max(0, before.size - 256 * 1024);
    const bytes = Buffer.alloc(before.size - start);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!bytesRead) return { activity: null, cacheable: false };
      offset += bytesRead;
    }
    const current = await lstat(candidate.path);
    const after = await file.stat();
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(before, current)
        || !sameFile(before, after) || after.size < before.size) return { activity: null, cacheable: false };
    const first = start ? bytes.indexOf(10) + 1 : 0;
    const last = bytes.lastIndexOf(10);
    if (last < first || (start && !first)) return { activity: null, cacheable: true };
    let latest = null;
    let future = false;
    let scoped = isCwdAllowed(candidate.cwd, roots);
    for (const line of bytes.subarray(first, last + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const request = row?.type === 'api-request' && typeof row.id === 'string' && row.id.trim();
      const message = ['user', 'assistant'].includes(row?.type) && row.message
        && typeof row.message === 'object' && !Array.isArray(row.message);
      if (!request && !message) continue;
      if (request && (row.isApiErrorMessage === true || row.isMeta === true
          || row.isVisibleInTranscriptOnly === true || row.isCompactSummary === true)) continue;
      if (row.sessionId !== candidate.sessionId) { scoped = false; continue; }
      if (row.cwd !== undefined) scoped = isCwdAllowed(row.cwd, roots);
      if (!scoped) continue;
      const at = eventTime(row.timestamp);
      if (at !== null && at > now) future = true;
      if (at !== null && at <= now && (latest === null || at > latest)) latest = at;
    }
    // Future timestamps may become current without a file change. Recheck them
    // next time rather than caching their temporary exclusion indefinitely.
    return { activity: latest, cacheable: !future };
  } finally { await file.close(); }
}

export async function discoverClaude({
  scopeRoot,
  repoRoot,
  projectsRoot,
  registryRoot,
  recentHours = 24,
  now = Date.now(),
  maxFiles = 100,
  worktreeRoots,
} = {}) {
  if (!absolute(scopeRoot) || !absolute(projectsRoot)) {
    throw new Error('Claude discovery requires explicit absolute scopeRoot and projectsRoot');
  }
  if ((repoRoot !== undefined && !absolute(repoRoot))
      || (registryRoot !== undefined && !absolute(registryRoot))
      || (worktreeRoots !== undefined && (!Array.isArray(worktreeRoots) || !worktreeRoots.every(absolute)))) {
    throw new Error('Claude discovery requires absolute optional roots');
  }
  if (!Number.isFinite(recentHours) || recentHours <= 0 || !Number.isFinite(now)
      || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) throw new Error('Invalid discovery limits');
  const stats = { registryFiles: 0, registryMatched: 0, registryErrors: 0, registryCacheHits: 0,
    gitError: false, candidateFiles: 0, recentFiles: 0, oversizedFiles: 0, truncated: 0,
    tailCheckedFiles: 0, tailCacheHits: 0, tailActiveFiles: 0, tailReadErrors: 0 };
  if (!worktreeRoots && repoRoot) {
    try {
      const { stdout } = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      worktreeRoots = stdout.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    } catch { worktreeRoots = []; stats.gitError = true; }
  }
  const roots = [...new Set([scopeRoot, repoRoot, ...(worktreeRoots || [])].filter(Boolean))];
  const directories = new Map();
  const windowsDirectories = new Map();
  const ids = new Map();
  const addDirectory = cwd => {
    // Case-insensitive Windows matching must not change POSIX project keys.
    const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd);
    const key = encoded(cwd);
    if (windows) windowsDirectories.set(key.toLowerCase(), cwd);
    else directories.set(key, cwd);
  };
  roots.forEach(addDirectory);
  const registryPaths = registryRoot ? await registryFiles(registryRoot) : [];
  stats.registryFiles = registryPaths.length;
  const present = new Set(registryPaths);
  for (const key of registryCache.keys()) {
    if (registryRoot && key.startsWith(`${registryRoot}${path.sep}`) && !present.has(key)) registryCache.delete(key);
  }
  for (const file of registryPaths) {
    try {
      const info = await stat(file);
      let cached = registryCache.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs && cached.size === info.size) stats.registryCacheHits++;
      else {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        const value = Object.fromEntries(['cwd', 'originCwd', 'worktreePath', 'cliSessionId', 'sessionId', 'lastAssistantCliSessionId', 'title']
          .map(key => [key, typeof raw[key] === 'string' ? raw[key] : null]));
        value.priorCliSessionIds = Array.isArray(raw.priorCliSessionIds) ? raw.priorCliSessionIds.filter(id => typeof id === 'string') : [];
        cached = { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, value };
        registryCache.set(file, cached);
      }
      const metadata = cached.value;
      const cwd = metadata.cwd || metadata.originCwd;
      if (!isCwdAllowed(cwd, roots)) continue;
      stats.registryMatched++;
      addDirectory(cwd);
      if (isCwdAllowed(metadata.worktreePath, roots)) addDirectory(metadata.worktreePath);
      for (const id of [metadata.cliSessionId, metadata.lastAssistantCliSessionId, ...metadata.priorCliSessionIds]) {
        if (uuid.test(id || '')) ids.set(id.toLowerCase(), {
          cwd, sessionId: metadata.sessionId || id, title: sanitizeTitle(metadata.title),
        });
      }
    } catch { stats.registryErrors++; }
  }
  const candidates = new Map();
  for (const directory of await entries(projectsRoot)) {
    if (!directory.isDirectory()) continue;
    const cwd = directories.get(directory.name) ?? windowsDirectories.get(directory.name.toLowerCase());
    for (const item of await entries(path.join(projectsRoot, directory.name))) {
      if (!item.isFile() || !item.name.endsWith('.jsonl') || !uuid.test(item.name.slice(0, -6))) continue;
      const id = item.name.slice(0, -6);
      const metadata = ids.get(id.toLowerCase());
      if (!cwd && !metadata) continue;
      const full = path.join(projectsRoot, directory.name, item.name);
      candidates.set(full, { path: full, cwd: metadata?.cwd || cwd, sessionId: id, title: metadata?.title || null });
    }
  }
  stats.candidateFiles = candidates.size;
  const files = [];
  const cutoff = now - recentHours * 3600000;
  for (const candidate of candidates.values()) {
    try {
      const info = await lstat(candidate.path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      let latestActivityAt;
      if (info.mtimeMs < cutoff) {
        const key = JSON.stringify([candidate.path, candidate.sessionId, candidate.cwd, roots]);
        const fingerprint = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
        const cached = tailActivityCache.get(key);
        let activity;
        if (cached && cached.fingerprint === fingerprint && cached.asOf <= now) {
          stats.tailCacheHits++;
          activity = cached.activity;
          tailActivityCache.delete(key);
          tailActivityCache.set(key, cached);
        } else {
          tailActivityCache.delete(key);
          stats.tailCheckedFiles++;
          let result;
          try { result = await recentTailActivity(candidate, info, roots, now); }
          catch { stats.tailReadErrors++; continue; }
          activity = result.activity;
          if (result.cacheable) {
            // Keep only file/scope metadata and numeric times, never transcript text.
            tailActivityCache.set(key, { fingerprint, asOf: now, activity });
            while (tailActivityCache.size > TAIL_CACHE_LIMIT) tailActivityCache.delete(tailActivityCache.keys().next().value);
          }
        }
        if (activity === null || activity < cutoff) continue;
        latestActivityAt = new Date(activity).toISOString();
        stats.tailActiveFiles++;
      }
      files.push({ ...candidate, size: info.size, mtimeMs: info.mtimeMs, ...(latestActivityAt ? { latestActivityAt } : {}) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const activityTime = file => file.latestActivityAt ? Date.parse(file.latestActivityAt) : file.mtimeMs;
  files.sort((a, b) => activityTime(b) - activityTime(a) || a.path.localeCompare(b.path));
  stats.recentFiles = files.length;
  stats.oversizedFiles = files.filter(file => file.size > 32 * 1024 * 1024).length;
  stats.truncated = Math.max(0, files.length - maxFiles);
  return { files: files.slice(0, maxFiles), roots, stats };
}
