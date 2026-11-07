import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { isCwdAllowed } from './scope.mjs';
import { readCodexTitle } from './titles.mjs';

const HEADER_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const INDEX_BYTES = 8 * 1024 * 1024;
const ENTRY_LIMIT = 40_000;
const FILE_LIMIT = 2_000;
const filenameId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const isoDate = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const absolute = value => typeof value === 'string'
  && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));

async function regularFile(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) return null;
  const handle = await open(file, 'r');
  try {
    const current = await handle.stat();
    if (current.isFile() && sameFile(before, current)) return { handle, info: current };
    await handle.close();
    return null;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function timestamp(value, now) {
  const match = typeof value === 'string' ? isoDate.exec(value) : null;
  if (!match) return -Infinity;
  const year = Number(match[1]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(match[3]) > days[Number(match[2]) - 1]) return -Infinity;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now ? parsed : -Infinity;
}

async function readHeader(file, stats) {
  const parts = [];
  let length = 0;
  while (length < Math.min(file.info.size, HEADER_BYTES)) {
    const bytes = await readRange(file.handle, length, Math.min(4096, file.info.size - length, HEADER_BYTES - length));
    if (!bytes.length) break;
    stats.headerBytes += bytes.length;
    length += bytes.length;
    const newline = bytes.indexOf(10);
    parts.push(newline < 0 ? bytes : bytes.subarray(0, newline));
    if (newline >= 0) return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  if (file.info.size >= HEADER_BYTES) throw new Error('Header exceeds bound');
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function indexedActivity(indexPath, now, stats) {
  const result = new Map();
  let file;
  try {
    file = await regularFile(indexPath);
    if (!file) return result;
    stats.indexRegularFile = true;
    const start = Math.max(0, file.info.size - INDEX_BYTES);
    const bytes = await readRange(file.handle, start, Math.min(file.info.size, INDEX_BYTES));
    stats.indexBytes = bytes.length;
    const first = start ? bytes.indexOf(10) + 1 : 0;
    if (start && !first) return result;
    for (const line of bytes.subarray(first).toString('utf8').split(/\r?\n/)) {
      try {
        const row = JSON.parse(line);
        if (typeof row.id !== 'string') continue;
        const updated = timestamp(row.updated_at, now);
        if (updated > (result.get(row.id) ?? -Infinity)) result.set(row.id, updated);
      } catch { /* The index may end in a partially written record. */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') stats.indexErrors++; }
  finally { await file?.handle.close(); }
  return result;
}

async function children(directory, pattern, stats) {
  const result = [];
  if (stats.enumeratedEntries >= ENTRY_LIMIT) return result;
  let iterator;
  try {
    if (!(await lstat(directory)).isDirectory()) return result;
    iterator = await opendir(directory);
    for await (const item of iterator) {
      if (++stats.enumeratedEntries > ENTRY_LIMIT) { stats.enumerationLimited = true; break; }
      if (!item.isSymbolicLink() && pattern.test(item.name)) result.push(item);
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') stats.directoryErrors++;
  }
  return result.sort((a, b) => b.name.localeCompare(a.name));
}

function isMainSession(metadata) {
  return !metadata.parent_thread_id && !metadata.forked_from_id
    && !(metadata.source && typeof metadata.source === 'object'
      && Object.hasOwn(metadata.source, 'subagent'))
    && metadata.source !== 'subagent';
}

export async function discoverCodex({
  sessionsRoot,
  scopeRoots,
  recentHours = 24,
  now = Date.now(),
  maxFiles = 100,
  indexPath,
} = {}) {
  if (!Array.isArray(scopeRoots) || !scopeRoots.length || !scopeRoots.every(absolute)) {
    throw new Error('Codex discovery requires explicit absolute scopeRoots');
  }
  if (!absolute(sessionsRoot)) throw new Error('Codex discovery requires an explicit absolute sessionsRoot');
  indexPath ??= path.join(sessionsRoot, '..', 'session_index.jsonl');
  if (!absolute(sessionsRoot) || !absolute(indexPath) || !Number.isFinite(recentHours) || recentHours <= 0
      || !Number.isFinite(now) || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
    throw new Error('Invalid Codex discovery limits');
  }
  const roots = [...new Set(scopeRoots)];
  const stats = { enumeratedEntries: 0, enumerationLimited: false, directoryErrors: 0,
    candidateFiles: 0, inspectedFiles: 0, inspectionLimited: false, invalidHeaders: 0,
    outOfScope: 0, subagents: 0, readErrors: 0, indexErrors: 0, indexBytes: 0, indexRegularFile: false,
    headerBytes: 0, tailBytes: 0, recentFiles: 0, oversizedFiles: 0, truncated: 0 };
  const activity = await indexedActivity(indexPath, now, stats);
  const candidates = [];
  for (const year of await children(sessionsRoot, /^\d{4}$/, stats)) {
    if (!year.isDirectory()) continue;
    const yearPath = path.join(sessionsRoot, year.name);
    for (const month of await children(yearPath, /^(0[1-9]|1[0-2])$/, stats)) {
      if (!month.isDirectory()) continue;
      const monthPath = path.join(yearPath, month.name);
      for (const day of await children(monthPath, /^(0[1-9]|[12]\d|3[01])$/, stats)) {
        if (!day.isDirectory()) continue;
        const datePath = path.join(monthPath, day.name);
        for (const item of await children(datePath, /^rollout-.*\.jsonl$/, stats)) {
          if (!item.isFile()) continue;
          const id = filenameId.exec(item.name)?.[1];
          candidates.push({ path: path.join(datePath, item.name), indexedAt: activity.get(id) ?? -Infinity });
        }
      }
    }
  }
  candidates.sort((a, b) => b.indexedAt - a.indexedAt || b.path.localeCompare(a.path));
  stats.candidateFiles = candidates.length;
  stats.inspectionLimited = candidates.length > FILE_LIMIT;
  const files = [];
  const cutoff = now - recentHours * 3_600_000;
  for (const candidate of candidates.slice(0, FILE_LIMIT)) {
    let file;
    try {
      file = await regularFile(candidate.path);
      if (!file) continue;
      stats.inspectedFiles++;
      let header;
      try { header = await readHeader(file, stats); }
      catch { stats.invalidHeaders++; continue; }
      const metadata = header?.payload;
      const expectedId = filenameId.exec(candidate.path)?.[1];
      if (header?.type !== 'session_meta' || !metadata || typeof metadata.id !== 'string' || !metadata.id
          || metadata.id.toLowerCase() !== expectedId?.toLowerCase()
          || typeof metadata.cwd !== 'string') { stats.invalidHeaders++; continue; }
      if (!isCwdAllowed(metadata.cwd, roots)) { stats.outOfScope++; continue; }
      if (!isMainSession(metadata) || header.parent_thread_id || header.forked_from_id) { stats.subagents++; continue; }
      const start = Math.max(0, file.info.size - TAIL_BYTES);
      const tail = await readRange(file.handle, start, Math.min(file.info.size, TAIL_BYTES));
      stats.tailBytes += tail.length;
      const first = start ? tail.indexOf(10) + 1 : 0;
      let latest = Math.max(activity.get(metadata.id) ?? -Infinity, timestamp(header.timestamp, now));
      if (!start || first) {
        for (const line of tail.subarray(first).toString('utf8').split(/\r?\n/)) {
          try { latest = Math.max(latest, timestamp(JSON.parse(line)?.timestamp, now)); }
          catch { /* Ignore bounded prefix fragments and incomplete writes. */ }
        }
      }
      const after = await lstat(candidate.path);
      if (!after.isFile() || after.isSymbolicLink() || !sameFile(file.info, after) || after.size < file.info.size) {
        stats.readErrors++;
        continue;
      }
      // Open Windows transcripts can grow while mtime remains unchanged.
      if (latest < cutoff) continue;
      files.push({ path: candidate.path, sessionId: metadata.id, cwd: metadata.cwd,
        size: file.info.size, mtimeMs: file.info.mtimeMs, latestActivityAt: new Date(latest).toISOString() });
    } catch { stats.readErrors++; }
    finally { await file?.handle.close(); }
  }
  files.sort((a, b) => Date.parse(b.latestActivityAt) - Date.parse(a.latestActivityAt) || a.path.localeCompare(b.path));
  stats.recentFiles = files.length;
  stats.oversizedFiles = files.filter(file => file.size > 32 * 1024 * 1024).length;
  stats.truncated = Math.max(0, files.length - maxFiles);
  const selected = files.slice(0, maxFiles);
  for (const file of selected) file.title = stats.indexRegularFile ? await readCodexTitle(file.sessionId, { indexPath }) : null;
  return { files: selected, roots, stats };
}
