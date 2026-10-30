import { timestamp } from '../../../lib/timestamp.mjs';
import { readOpenHands } from '../../../lib/providers/openhands.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const naive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;
const text = (value, max = 240) => (typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).slice(0, max);

function active(check) {
  if (!check()) throw Object.assign(new Error('The page is no longer active.'), { name: 'AbortError' });
}

/** Use only the host's authenticated GET helper; never inspect backend credentials. */
export function createClient(request) {
  if (typeof request !== 'function') throw new TypeError('An authenticated Agent Server request helper is required.');

  async function pages(path, sort, maximumPages, isActive) {
    const items = [];
    const cursors = new Set();
    const warnings = [];
    let cursor;
    for (let page = 0; page < maximumPages; page++) {
      active(isActive);
      const query = new URLSearchParams({ limit: '100', sort_order: sort });
      if (cursor) query.set('page_id', cursor);
      let result;
      try { result = await request({ method: 'GET', path: `${path}?${query}` }); }
      catch { active(isActive); throw new Error('Could not read the active Agent Server. Check that the supported local backend is connected, then retry.'); }
      active(isActive);
      if (!object(result) || !Array.isArray(result.items) || result.items.length > 100 ||
          (result.next_page_id != null && (typeof result.next_page_id !== 'string' || result.next_page_id.length > 4096))) {
        throw new Error('The Agent Server returned an invalid history page. Check its version and retry.');
      }
      items.push(...result.items);
      cursor = result.next_page_id;
      if (!cursor) return { items, warnings };
      if (cursors.has(cursor)) throw new Error('The Agent Server repeated a pagination cursor. Refresh after checking the backend version.');
      cursors.add(cursor);
    }
    warnings.push(`Showing at most ${maximumPages * 100} recent records; older history is omitted by the page limit.`);
    return { items, warnings };
  }

  return {
    async listConversations({ isActive = () => true } = {}) {
      const result = await pages('/api/conversations/search', 'CREATED_AT_DESC', 5, isActive);
      const conversations = new Map();
      for (const item of result.items) {
        if (!object(item) || typeof item.id !== 'string' || !uuid.test(item.id)) {
          result.warnings.push('A conversation with an invalid ID was skipped.');
          continue;
        }
        if (!conversations.has(item.id)) conversations.set(item.id, { id: item.id, title: text(item.title) || item.id, status: text(item.execution_status, 80) || 'unknown' });
      }
      return { conversations: [...conversations.values()], warnings: [...new Set(result.warnings)].slice(0, 100) };
    },

    async readConversation(id, { utcOffset = '', isActive = () => true } = {}) {
      if (typeof id !== 'string' || !uuid.test(id)) throw new TypeError('Select a valid conversation ID.');
      if (typeof utcOffset !== 'string') throw new TypeError('Use an explicit server UTC offset such as +00:00, or leave it blank.');
      const offset = utcOffset.trim();
      if (offset && (!/^[+-]\d{2}:\d{2}$/.test(offset) || +offset.slice(1, 3) > 14 || +offset.slice(4) > 59 || (+offset.slice(1, 3) === 14 && +offset.slice(4) !== 0))) {
        throw new TypeError('Use a server UTC offset from -14:00 to +14:00 in ±HH:MM form, or leave it blank.');
      }
      const result = await pages(`/api/conversations/${encodeURIComponent(id)}/events/search`, 'TIMESTAMP_DESC', 20, isActive);
      const records = new Map();
      const warnings = result.warnings;
      const warn = message => { if (warnings.length < 100 && !warnings.includes(message)) warnings.push(message); };
      // Reverse the bounded newest-first window; ties retain the server's record order.
      for (const row of [...result.items].reverse()) {
        if (!object(row) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 512) { warn('An event with a missing or invalid stable ID was skipped.'); continue; }
        if (!records.has(row.id)) records.set(row.id, row);
      }
      let converted = false;
      const eventTimestamp = value => {
        const reported = timestamp(value);
        if (reported) return reported;
        if (offset && typeof value === 'string' && naive.test(value)) {
          const interpreted = timestamp(`${value}${offset}`);
          if (interpreted) converted = true;
          return interpreted;
        }
        return null;
      };
      const rows = [...records.values()];
      const untimedEvents = rows.filter(row => !eventTimestamp(row.timestamp) && !timestamp(row.runwardObservedAt)).map(row => ({
        id: text(row.id, 512), kind: text(row.kind, 80) || 'Unknown event', label: text(row.tool_name) || text(row.kind) || 'Unknown event', rawTimestamp: text(row.timestamp, 128) || 'Timestamp missing',
      }));
      const parsed = readOpenHands('', { timestamp: eventTimestamp, jsonRecords: () => rows, warn });
      const spans = (parsed.events ?? []).map(span => ({
        id: `${id}:${text(String(span.id), 512)}`, kind: span.kind, label: text(span.label),
        detail: text(typeof span.detail === 'string' ? span.detail : JSON.stringify(span.detail ?? ''), 12000), startedAt: span.startedAt, endedAt: span.endedAt,
      })).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
      if (untimedEvents.length) warn(`${untimedEvents.length} records have unknown or invalid timing. Timezone-naive events remain in the untimed event list until you explicitly supply the server UTC offset.`);
      if (converted) warn(`Timezone-naive events use the user-supplied fixed UTC offset ${offset}. Verify it for this history; daylight-saving and historical offset changes are not resolved automatically.`);
      return { spans, untimedEvents, warnings, eventCount: rows.length, timingBasis: converted ? 'fixed-offset' : spans.length ? 'reported' : 'unknown', status: parsed.status };
    },
  };
}
