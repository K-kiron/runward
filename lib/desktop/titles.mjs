import { open } from 'node:fs/promises';
import path from 'node:path';

const maxIndexBytes = 8 * 1024 * 1024;

// Titles remain plain text. Never derive a fallback from session IDs or messages.
export function sanitizeTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return title ? title.slice(0, 160).replace(/[\uD800-\uDBFF]$/, '') : null;
}

export async function readCodexTitle(threadId, {
  indexPath,
} = {}) {
  if (typeof indexPath !== 'string' || !(path.posix.isAbsolute(indexPath) || path.win32.isAbsolute(indexPath))) {
    throw new Error('Codex title lookup requires an explicit absolute indexPath');
  }
  if (typeof threadId !== 'string' || !threadId) return null;
  let handle;
  try {
    handle = await open(indexPath, 'r');
    if ((await handle.stat()).size > maxIndexBytes) return null;
    const buffer = Buffer.alloc(maxIndexBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxIndexBytes) return null;
    let title = null;
    let updatedAt = -Infinity;
    for (const line of buffer.toString('utf8', 0, length).split(/\r?\n/)) {
      try {
        const entry = JSON.parse(line);
        if (entry?.id !== threadId) continue;
        const timestamp = Date.parse(entry.updated_at);
        const order = Number.isFinite(timestamp) ? timestamp : -Infinity;
        // Later entries win equal timestamps, including indexes without dates.
        if (order >= updatedAt) {
          title = sanitizeTitle(entry.thread_name);
          updatedAt = order;
        }
      } catch { /* Ignore incomplete or malformed index lines. */ }
    }
    return title;
  } catch { return null; }
  finally { await handle?.close(); }
}
