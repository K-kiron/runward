import { createHash } from 'node:crypto';
import { readDsh } from './providers/dsh.mjs';
import { readOpenCode } from './providers/opencode.mjs';
import { readOpenHands } from './providers/openhands.mjs';
import { readGemini } from './providers/gemini.mjs';

export const TRANSCRIPT_PROVIDERS = ['claude', 'codex', 'dsh', 'opencode', 'openhands', 'gemini'];
const readers = { dsh: readDsh, opencode: readOpenCode, openhands: readOpenHands, gemini: readGemini };
const names = { dsh: 'DSH', opencode: 'OpenCode', openhands: 'OpenHands', gemini: 'Gemini CLI' };
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Accept a JSON export or independently parseable JSONL records. */
export function jsonRecords(text, warn) {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];
  try {
    const value = JSON.parse(clean);
    return Array.isArray(value) ? value : [value];
  } catch { /* A live JSONL file can end with an unfinished record. */ }
  const records = [];
  for (const [index, line] of clean.split('\n').entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { warn(`Line ${index + 1}: incomplete or malformed JSON record skipped.`); }
  }
  return records;
}

export function parseAdditionalTranscript(text, { provider, sourceId, project }, helpers) {
  const warnings = [];
  let omitted = 0;
  const warn = message => warnings.length < 100 ? warnings.push(message) : omitted++;
  const parsed = readers[provider](text, { ...helpers, warn, jsonRecords });
  let clipped = false;
  const display = (value, limit) => {
    const raw = typeof value === 'string' ? value : '';
    const visible = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (visible !== raw || visible.length > limit) clipped = true;
    return visible.slice(0, limit);
  };
  const agentId = `${provider}-${digest(sourceId)}`;
  const events = new Map();
  for (const span of parsed.events ?? []) {
    if (!object(span) || (typeof span.id !== 'string' && typeof span.id !== 'number') || String(span.id) === '') {
      warn('An event without a stable ID was skipped.'); continue;
    }
    const startedAt = helpers.timestamp(span.startedAt);
    const endedAt = span.endedAt === null ? null : helpers.timestamp(span.endedAt);
    if (!startedAt || (span.endedAt !== null && (!endedAt || endedAt < startedAt))) {
      warn('An event with missing or invalid timing was skipped.'); continue;
    }
    if (!['thinking', 'tool', 'subagent', 'error', 'message'].includes(span.kind)) {
      warn('An event with an unsupported kind was skipped.'); continue;
    }
    const id = `${agentId}-${digest(String(span.id))}`;
    events.set(id, { id, agentId, laneId: display(span.laneId ?? 'main', 160) || 'main',
      kind: span.kind, label: display(span.label, 240), startedAt, endedAt,
      detail: display(typeof span.detail === 'string' ? span.detail : JSON.stringify(span.detail ?? ''), 12000) });
  }
  let spans = [...events.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const starts = [helpers.timestamp(parsed.startedAt), ...spans.map(span => span.startedAt)].filter(Boolean).sort();
  const ends = [helpers.timestamp(parsed.lastSeen), ...spans.map(span => span.endedAt ?? span.startedAt), ...starts.slice(0, 1)].filter(Boolean).sort();
  const cwd = display(parsed.cwd, 2048);
  const name = names[provider];
  const agent = starts.length ? { id: agentId,
    name: display(parsed.name, 240) || display(`${name}${parsed.sessionId ? ` ${parsed.sessionId}` : ' session'}`, 240),
    project: display(project ?? (cwd.split(/[\\/]/).filter(Boolean).at(-1) || 'Imported sessions'), 200),
    provider: name, status: ['working', 'idle', 'waiting', 'offline'].includes(parsed.status) ? parsed.status : 'unknown',
    startedAt: starts[0], lastSeen: ends.at(-1), cwd,
    contextUsed: Number.isSafeInteger(parsed.contextUsed) && parsed.contextUsed >= 0 ? parsed.contextUsed : null,
    contextLimit: Number.isSafeInteger(parsed.contextLimit) && parsed.contextLimit > 0 ? parsed.contextLimit : null,
  } : null;
  if (!agent && text.trim()) warn('No recognized, timestamped session records were imported. Check the provider and export format.');
  if (spans.length > 5000) { warn(`Retained the latest 5000 of ${spans.length} spans.`); spans = spans.slice(-5000); }
  if (clipped) warn('Imported text was clipped or control characters escaped for display.');
  if (omitted) warnings.push(`${omitted} additional parser warnings omitted.`);
  return { commands: agent ? [{ type: 'agent.upsert', data: agent }, ...spans.map(data => ({ type: 'span.upsert', data }))] : [], warnings };
}
