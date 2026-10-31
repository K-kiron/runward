import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = (path, info) => ({ realpath: path, dev: String(info.dev), ino: String(info.ino) });
const sameFile = (a, b) => a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino;
const changed = reason => Object.assign(new Error(`${reason}; source paused; reenroll with a new generation`), { sourcePaused: true });

async function inspect(path) {
  const link = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isFile()) throw Object.assign(new Error('Selected transcript is not a file'), { code: 'ENOTFILE' });
  return { canonical, link: `${link.dev}:${link.ino}` };
}

async function readSelected(path, expected) {
  let file;
  try {
    const before = await inspect(path);
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const first = await file.stat({ bigint: true });
    if (!first.isFile()) throw Object.assign(new Error('Selected transcript is not a file'), { code: 'ENOTFILE' });
    if (first.ino === 0n) throw new Error('Selected filesystem does not expose a stable file identity');
    const fileIdentity = identity(before.canonical, first);
    if (expected && (!sameFile(fileIdentity, expected.fileIdentity) || before.link !== expected.link)) {
      throw changed('Selected transcript was replaced or its link target changed');
    }
    if (first.size < BigInt(expected?.size ?? 0)) throw changed('Selected transcript was truncated');
    if (first.size > BigInt(MAX_TRANSCRIPT_BYTES)) throw new Error('Selected transcript exceeds 32 MiB');
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_TRANSCRIPT_BYTES + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
      if (size > MAX_TRANSCRIPT_BYTES) throw new Error('Selected transcript exceeds 32 MiB');
    }
    const bytes = Buffer.concat(chunks, size);
    const last = await file.stat({ bigint: true });
    const after = await inspect(path);
    // Check the pathname again after reading: a renamed open descriptor still
    // points to its old inode, so fstat alone would miss a replacement.
    const current = await lstat(after.canonical, { bigint: true });
    if (!sameFile(fileIdentity, identity(after.canonical, current)) || before.link !== after.link ||
        !sameFile(fileIdentity, identity(before.canonical, last))) {
      throw changed('Selected transcript was replaced or its link target changed');
    }
    if (last.size < first.size || bytes.length < (expected?.size ?? 0)) throw changed('Selected transcript was truncated');
    if (expected && digest(bytes.subarray(0, expected.size)) !== expected.prefixHash) {
      throw changed('Previously enrolled transcript content changed');
    }
    return { bytes, fileIdentity, link: after.link, size, prefixHash: digest(bytes) };
  } catch (error) {
    if (expected && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'ENOTFILE'].includes(error.code)) throw changed('Selected transcript or its link target disappeared or changed type');
    throw error;
  } finally { await file?.close(); }
}

// watchBinding is process-local; persist only path and fileIdentity in the
// source descriptor. Keeping the selected spelling catches junction retargets.
export async function enrollTranscript(source, baseDirectory = process.cwd()) {
  const selectedPath = resolve(baseDirectory, source.path);
  const read = await readSelected(selectedPath);
  if (source.fileIdentity && !sameFile(source.fileIdentity, read.fileIdentity)) throw changed('Selected transcript does not match its saved file identity');
  return { ...source, path: read.fileIdentity.realpath, fileIdentity: read.fileIdentity,
    watchBinding: { selectedPath, fileIdentity: read.fileIdentity, link: read.link, size: read.size, prefixHash: read.prefixHash } };
}

export async function readEnrolledTranscript(source) {
  const binding = source.watchBinding;
  const read = await readSelected(binding.selectedPath, binding);
  binding.size = read.size;
  binding.prefixHash = read.prefixHash;
  return { bytes: read.bytes, signature: read.prefixHash };
}
