import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseTranscript } from './adapters.mjs';
import { decompressFrames } from './zstd.mjs';

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

// shortcut: reparse selected files up to 32 MiB; add incremental cursors for larger logs.
export function watchTranscripts(sources, dispatch, report = console.error, interval = 2000) {
  let stopped = false;
  let timer;
  let running;
  const signatures = new Map();
  const acknowledged = new Map();
  const errors = new Map();
  async function poll() {
    for (const { provider, path } of sources) {
      if (stopped) return;
      const absolute = resolve(path);
      const key = `${provider}:${absolute}`;
      try {
        const info = await stat(absolute);
        if (!info.isFile()) throw new Error('Selected transcript is not a file');
        if (info.size > MAX_TRANSCRIPT_BYTES) throw new Error('Selected transcript exceeds 32 MiB');
        const signature = `${info.ino}:${info.mtimeMs}:${info.size}`;
        if (signatures.get(key) === signature) continue;
        let bytes = await readFile(absolute);
        if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new Error('Selected transcript exceeds 32 MiB');
        if (/\.(?:zstd|zst)$/i.test(absolute)) bytes = decompressFrames(bytes);
        const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
          : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
        const text = new TextDecoder(encoding).decode(bytes);
        const sourceId = createHash('sha256').update(key).digest('hex').slice(0, 20);
        const { commands, warnings } = parseTranscript(text, { provider, sourceId });
        const prior = acknowledged.get(key) ?? new Map();
        acknowledged.set(key, prior);
        const retained = new Set();
        const pending = [];
        for (const command of commands) {
          const commandKey = `${command.type}:${command.data.id}`;
          retained.add(commandKey);
          const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
          if (prior.get(commandKey) !== fingerprint) pending.push({ command, commandKey, fingerprint });
        }
        for (const commandKey of prior.keys()) if (!retained.has(commandKey)) prior.delete(commandKey);
        for (let index = 0; index < pending.length; index += 1000) {
          const batch = pending.slice(index, index + 1000);
          await dispatch(batch.map(item => item.command));
          for (const { commandKey, fingerprint } of batch) prior.set(commandKey, fingerprint);
        }
        signatures.set(key, signature);
        errors.delete(key);
        if (warnings.length) report(`${provider}: ${warnings.length} transcript warning(s); unsupported or incomplete records may be omitted.`);
      } catch (error) {
        if (errors.get(key) !== error.message) report(`${provider}: ${error.message}`);
        errors.set(key, error.message);
      }
    }
  }
  const tick = () => { running = poll().finally(() => { if (!stopped) { timer = setTimeout(tick, interval); timer.unref(); } }); };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
