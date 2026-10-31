import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseTranscript } from './adapters.mjs';
import { decompressFrames } from './zstd.mjs';
import { enrollTranscript, readEnrolledTranscript } from './enrollment.mjs';

// shortcut: reparse selected files up to 32 MiB; add incremental cursors for larger logs.
export function watchTranscripts(sources, dispatch, report = console.error, interval = 2000) {
  let stopped = false;
  let timer;
  let running;
  const signatures = new Map();
  const acknowledged = new Map();
  const errors = new Map();
  const paused = new Set();
  const enrolled = new Map();
  async function poll() {
    for (const source of sources) {
      if (stopped) return;
      const { provider, path } = source;
      const absolute = resolve(path);
      const key = source.id ? `${source.id}:${source.generation}` : `${provider}:${absolute}`;
      if (paused.has(key)) continue;
      try {
        if (!enrolled.has(key)) enrolled.set(key, source.watchBinding ? source : await enrollTranscript(source));
        const bound = enrolled.get(key);
        let { bytes, signature } = await readEnrolledTranscript(bound);
        if (signatures.get(key) === signature) continue;
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
          if (stopped || paused.has(key)) return;
          await dispatch(batch.map(item => item.command), source);
          for (const { commandKey, fingerprint } of batch) prior.set(commandKey, fingerprint);
        }
        signatures.set(key, signature);
        errors.delete(key);
        if (warnings.length) report(`${provider}: ${warnings.length} transcript warning(s); unsupported or incomplete records may be omitted.`);
      } catch (error) {
        if (error.sourcePaused || error.code === 'SOURCE_REVOKED') paused.add(key);
        if (errors.get(key) !== error.message) report(`${provider}: ${error.message}`);
        errors.set(key, error.message);
      }
    }
  }
  const tick = () => { running = poll().finally(() => { if (!stopped) { timer = setTimeout(tick, interval); timer.unref(); } }); };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
