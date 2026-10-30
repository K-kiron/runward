// Built from Runward's shared reader and Canvas sources. Rebuild with npm run build:canvas.
const { timestamp } = (() => {
/** Normalize an explicit, valid ISO timestamp without guessing a timezone. */
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+month - 1];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
return { timestamp };
})();

const { readOpenHands } = (() => {
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = new Set(['ActionEvent', 'ObservationEvent', 'AgentErrorEvent', 'UserRejectObservation', 'MessageEvent', 'ConversationStateUpdateEvent', 'ConversationErrorEvent', 'PauseEvent']);
const statuses = { running: 'working', idle: 'idle', finished: 'idle', paused: 'waiting', waiting_for_confirmation: 'waiting', error: 'idle', stuck: 'idle' };
const readable = content => Array.isArray(content) ? content.filter(part => object(part) && typeof part.text === 'string').map(part => part.text).join('\n') : '';

/** Read current SDK events, including the CLI's --headless --json stream. */
function readOpenHands(text, { warn, timestamp, jsonRecords }) {
  const parsed = { events: [], status: 'unknown' };
  const seen = new Set();
  const rows = [];
  let observed = false;
  for (const [index, row] of jsonRecords(text, warn).entries()) {
    if (!object(row)) { warn('OpenHands record must be a JSON object; skipped.'); continue; }
    if (!kinds.has(row.kind)) continue;
    if (typeof row.id !== 'string' || !row.id.trim()) { warn('OpenHands event has no stable ID; skipped.'); continue; }
    const upstream = timestamp(row.timestamp);
    const at = upstream ?? timestamp(row.runwardObservedAt);
    if (!at) { warn('OpenHands event has no timestamp with an explicit timezone or capture observation; skipped.'); continue; }
    if (!upstream) observed = true;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({ row, at, index });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
  if (!rows.length) return parsed;
  parsed.startedAt = rows[0].at;
  parsed.lastSeen = rows.at(-1).at;
  const actions = new Map();
  const tools = new Map();
  const instant = (id, kind, label, detail, at) => parsed.events.push({ id, kind, label, detail, startedAt: at, endedAt: at });
  for (const { row, at } of rows) {
    if (row.kind === 'ActionEvent') {
      if (typeof row.tool_call_id !== 'string' || !row.tool_call_id.trim()) { warn('OpenHands action has no tool-call ID; skipped.'); continue; }
      if (actions.has(row.tool_call_id)) { warn('Repeated OpenHands tool-call ID; retained its first action.'); continue; }
      const span = { id: `tool:${row.tool_call_id}`, kind: 'tool', label: typeof row.tool_name === 'string' ? row.tool_name : 'Tool request', startedAt: at, endedAt: null, detail: row.action ?? row.tool_call ?? '' };
      actions.set(row.tool_call_id, { row, span });
      tools.set(row.tool_call_id, span);
      const thought = [readable(row.thought), typeof row.reasoning_content === 'string' ? row.reasoning_content : ''].filter(Boolean).join('\n');
      if (thought) instant(`thought:${row.id}`, 'thinking', 'Action thought', thought, at);
    } else if (row.kind === 'MessageEvent') {
      if (!object(row.llm_message)) { warn('OpenHands message has no LLM message; skipped.'); continue; }
      const message = readable(row.llm_message.content);
      if (message) instant(`event:${row.id}`, 'message', row.source === 'user' ? 'User message' : 'Agent message', message, at);
      if (typeof row.llm_message.reasoning_content === 'string' && row.llm_message.reasoning_content) instant(`thought:${row.id}`, 'thinking', 'Message reasoning', row.llm_message.reasoning_content, at);
    } else if (row.kind === 'ConversationStateUpdateEvent') {
      const state = row.key === 'full_state' && object(row.value) ? row.value : null;
      if (state) {
        if (typeof state.id === 'string') parsed.sessionId = state.id;
        if (typeof state.workspace?.working_dir === 'string') parsed.cwd = state.workspace.working_dir;
      }
      if (row.key === 'workspace' && typeof row.value?.working_dir === 'string') parsed.cwd = row.value.working_dir;
      const status = state?.execution_status ?? (row.key === 'execution_status' ? row.value : undefined);
      if (typeof status === 'string') {
        parsed.status = Object.hasOwn(statuses, status) ? statuses[status] : 'unknown';
        instant(`event:${row.id}`, ['error', 'stuck'].includes(status) ? 'error' : 'message', 'Conversation state', status, at);
      }
    } else if (row.kind === 'ConversationErrorEvent') {
      instant(`event:${row.id}`, 'error', typeof row.code === 'string' ? row.code : 'Conversation error', row.detail ?? '', at);
    } else if (row.kind === 'PauseEvent') {
      parsed.status = 'waiting';
      instant(`event:${row.id}`, 'message', 'Conversation paused', '', at);
    }
  }
  const closed = new Set();
  for (const { row, at } of rows) {
    if (!['ObservationEvent', 'AgentErrorEvent', 'UserRejectObservation'].includes(row.kind)) continue;
    if (typeof row.tool_call_id !== 'string' || !row.tool_call_id.trim()) { warn('OpenHands observation has no tool-call ID; skipped.'); continue; }
    const action = actions.get(row.tool_call_id);
    if (action && typeof row.action_id === 'string' && row.action_id !== action.row.id) { warn('OpenHands observation action ID does not match its tool call; skipped.'); continue; }
    if (action && at < action.span.startedAt) { warn('OpenHands observation predates its action; duration left open.'); continue; }
    if (closed.has(row.tool_call_id)) { warn('Repeated OpenHands observation; retained its first result.'); continue; }
    const observation = object(row.observation) ? row.observation : null;
    if (row.kind === 'ObservationEvent' && !observation) { warn('OpenHands observation payload is missing; skipped.'); continue; }
    const failed = row.kind === 'AgentErrorEvent' || row.kind === 'UserRejectObservation' || observation?.is_error === true ||
      (observation?.kind === 'TerminalObservation' && Number.isInteger(observation.exit_code) && ![0, -1].includes(observation.exit_code));
    const output = row.kind === 'AgentErrorEvent' ? row.error : row.kind === 'UserRejectObservation' ? row.rejection_reason : observation;
    const span = action?.span ?? { id: `tool:${row.tool_call_id}`, label: typeof row.tool_name === 'string' ? row.tool_name : 'Tool observation', startedAt: at };
    if (!action) warn('OpenHands observation has no matching action; shown as an instant.');
    span.kind = failed ? 'error' : 'tool';
    span.endedAt = at;
    const sections = [action ? JSON.stringify(action.row.action ?? action.row.tool_call ?? '') : '', typeof output === 'string' ? output : JSON.stringify(output ?? '')];
    if (sections.some(section => section.length > 5900)) warn('OpenHands paired input/output was clipped to 5900 characters per section.');
    span.detail = `${action ? `Input:\n${sections[0].slice(0, 5900)}\n\n` : ''}Observation:\n${sections[1].slice(0, 5900)}`;
    tools.set(row.tool_call_id, span);
    closed.add(row.tool_call_id);
  }
  parsed.events.push(...tools.values());
  if (observed) warn('Some OpenHands timestamps use capture observation times because upstream timestamps lacked a timezone; these durations include delivery or buffering time.');
  if (tools.size) warn('OpenHands tool intervals use action and observation records; they do not prove that a background process has finished.');
  return parsed;
}
return { readOpenHands };
})();

const { createClient } = (() => {
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const naive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;
const text = (value, max = 240) => (typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).slice(0, max);

function active(check) {
  if (!check()) throw Object.assign(new Error('The page is no longer active.'), { name: 'AbortError' });
}

/** Use only the host's authenticated GET helper; never inspect backend credentials. */
function createClient(request) {
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
return { createClient };
})();

const { styles } = (() => {
// Loaded inside the page's shadow root; these rules never style the host application.
const styles = `
:host {
  display: block;
  min-width: 0;
  container-type: inline-size;
  color-scheme: dark;
  --ground: #171719;
  --surface: #131217;
  --raised: #212023;
  --border: #2b2a2f;
  --control: #45444a;
  --text: #f3f3f4;
  --muted: #a5a5ad;
  --accent: #72a8e9;
  --positive: #5fc39c;
  --warning: #e3b35e;
  --negative: #ef8597;
  font: 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
h1, h2, h3, p { margin: 0; }
button, input, select { font: inherit; }
button, input, select, summary { touch-action: manipulation; }
button, input, select {
  min-height: 40px;
  min-width: 0;
  padding: 7px 11px;
  border: 1px solid var(--control);
  border-radius: 6px;
  color: var(--text);
  background: var(--ground);
}
button, select, summary { cursor: pointer; }
button:hover { border-color: var(--muted); }
button:active { background: var(--raised); }
button[aria-disabled="true"], select:disabled { color: var(--muted); cursor: wait; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible,
[tabindex="0"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
input::placeholder { color: var(--muted); }
select { width: 100%; max-width: 100%; }
p, h1, h2, h3, li, dd { overflow-wrap: anywhere; }
h1 { font-size: 25px; line-height: 1.2; font-weight: 600; letter-spacing: -.025em; }
h2 { font-size: 15px; font-weight: 600; }
h3 { font-size: 14px; font-weight: 500; }
.app { min-height: 360px; padding: 24px; color: var(--text); background: var(--ground); }
.topbar, .heading, .panel-heading, .actions, .legend, .facts, .timing-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.topbar { padding-bottom: 18px; margin-bottom: 22px; border-bottom: 1px solid var(--border); }
.brand { font-size: 23px; font-weight: 650; letter-spacing: -.05em; }
.brand-mark { display: inline-block; color: var(--accent); letter-spacing: -.18em; margin-right: 10px; }
.backend { color: var(--muted); overflow-wrap: anywhere; min-width: 0; flex: 1; }
.badge { border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; font-size: 11px; color: var(--muted); }
.heading { align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
.heading p { margin-top: 7px; color: var(--muted); }
.toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: end; }
.field { display: grid; gap: 6px; min-width: 0; }
.field > label, .field-label { color: var(--muted); font-size: 12px; }
.auto-refresh { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; min-height: 40px; color: var(--muted); }
.auto-refresh input { min-height: 0; width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.freshness { min-height: 24px; margin: 10px 0 16px; font-size: 12px; color: var(--muted); }
.timing { padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; }
.timing-heading { justify-content: space-between; gap: 16px; }
.offset-form { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; }
.offset-form input { width: 116px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.timing-copy { max-width: 85ch; color: var(--muted); font-size: 12px; margin-top: 10px; }
.timing details { color: var(--muted); font-size: 12px; margin-top: 8px; }
.timing details p { padding-top: 8px; }
.offset-error { color: var(--negative); font-size: 12px; margin-top: 8px; }
.error { border: 1px solid #6e3d47; background: #251c21; padding: 12px 14px; border-radius: 6px; margin-bottom: 16px; color: #f6c3cd; }
.facts { gap: 14px 30px; margin-bottom: 18px; }
.fact { display: flex; align-items: baseline; gap: 8px; color: var(--muted); font-size: 12px; }
.fact strong { color: var(--text); font-weight: 500; font-size: 18px; }
.fact:last-child strong { font-size: 13px; }
.warnings { border-left: 2px solid var(--warning); background: var(--surface); padding: 10px 14px; margin-bottom: 16px; }
.warnings summary { color: var(--warning); }
.warnings ul { margin: 10px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
.warnings li + li { margin-top: 6px; }
.panel { min-width: 0; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; }
.panel-heading { justify-content: space-between; padding: 15px 16px 8px; }
.count { color: var(--muted); font-size: 12px; font-weight: 400; margin-left: 7px; }
.section-note { color: var(--muted); font-size: 12px; padding: 0 16px 12px; }
.waterfall { max-height: 360px; overflow: auto; padding: 0 16px 12px; }
.axis, .lane { display: grid; grid-template-columns: 95px minmax(0, 1fr); gap: 12px; }
.axis { color: var(--muted); font-size: 11px; padding: 8px 0; }
.axis-times { display: flex; justify-content: space-between; gap: 8px; }
.lane { align-items: center; border-top: 1px solid var(--border); }
.lane-name { font-size: 12px; align-self: start; padding-top: 13px; }
.lane-track { position: relative; height: 44px; min-width: 0; }
.lane-track::before { content: ''; position: absolute; inset: 13px 0; background: var(--ground); border-radius: 3px; }
.span-mark { position: absolute; top: 4px; height: 36px; min-height: 36px; min-width: 7px; padding: 0; border: 0; border-radius: 2px; background: transparent; }
.span-mark::before { content: ''; position: absolute; top: 9px; bottom: 9px; left: 0; right: 0; background: var(--kind-color); border-radius: 2px; opacity: .85; }
.span-mark[aria-pressed="true"]::before { outline: 2px solid var(--text); outline-offset: 2px; opacity: 1; }
.span-mark:hover, .span-mark:focus-visible { z-index: 2; background: transparent; }
.span-mark.open::before { background: transparent; border: 2px dotted var(--kind-color); }
.kind-thinking { --kind-color: var(--positive); }
.kind-tool { --kind-color: var(--warning); }
.kind-subagent { --kind-color: var(--accent); }
.kind-error { --kind-color: var(--negative); }
.kind-message { --kind-color: var(--muted); }
.legend { border-top: 1px solid var(--border); padding: 11px 16px; gap: 8px 16px; color: var(--muted); font-size: 11px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-mark { width: 8px; height: 8px; border-radius: 1px; background: var(--kind-color); }
.empty { padding: 22px 16px; color: var(--muted); }
.waterfall > .empty { padding-left: 0; padding-right: 0; }
.lower-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-top: 16px; align-items: start; }
.console { max-height: 420px; overflow: auto; padding: 0 16px; }
.event-item { border-top: 1px solid var(--border); padding: 10px 0; }
.event-button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 44px; padding: 7px 0; border: 0; background: transparent; border-radius: 0; text-align: left; }
.event-button[aria-pressed="true"] { color: var(--accent); }
.event-button:hover { background: var(--raised); }
.event-button .legend-mark { flex: 0 0 8px; }
.event-label { overflow-wrap: anywhere; min-width: 0; }
.event-meta { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.event-preview { color: var(--muted); margin-top: 6px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.more { margin: 12px 16px; }
.detail-content { padding: 10px 16px 16px; }
.detail-meta { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 12px; margin: 12px 0; font-size: 12px; }
.detail-meta dt { color: var(--muted); }
.detail-meta dd { margin: 0; }
.detail-pre { margin: 12px 0 0; padding: 12px; border-radius: 4px; background: var(--ground); color: var(--muted); font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.untimed-panel { margin-top: 16px; }
.untimed-list { list-style: none; margin: 0; padding: 0 16px; max-height: 340px; overflow: auto; }
.untimed-item { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 5px 14px; border-top: 1px solid var(--border); padding: 12px 0; }
.untimed-kind { color: var(--muted); font-size: 12px; }
.untimed-time { grid-column: 2; font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--muted); overflow-wrap: anywhere; }
.footer { color: var(--muted); font-size: 11px; margin-top: 18px; }
@container (max-width: 680px) {
  .app { padding: 16px; }
  .topbar { gap: 8px 12px; margin-bottom: 18px; }
  .backend { flex-basis: calc(100% - 120px); }
  .toolbar { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .actions { justify-content: space-between; }
  .lower-grid { grid-template-columns: minmax(0, 1fr); }
  .offset-form { width: 100%; }
  .offset-form .field { flex: 1; }
  .offset-form input { width: 100%; }
  .timing-heading { gap: 10px; }
  .axis, .lane { grid-template-columns: 70px minmax(0, 1fr); gap: 8px; }
  .axis-mid { display: none; }
  .facts { gap: 10px 20px; }
  .untimed-item { grid-template-columns: 70px minmax(0, 1fr); gap: 5px 8px; }
  button, input, select, .auto-refresh { min-height: 44px; }
  .auto-refresh input { min-height: 0; }
  .span-mark { min-height: 36px; }
}
`;
return { styles };
})();

const { mountPage } = (() => {
const kinds = ['thinking', 'tool', 'subagent', 'error', 'message'];
const kindNames = { thinking: 'Thinking', tool: 'Tools', subagent: 'Subagents', error: 'Errors', message: 'Messages' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '') => typeof value === 'string' && value ? value : fallback;
const time = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const clock = value => new Date(value).toISOString().slice(11, 19);
const dateTime = value => time(value) === null ? 'Unknown' : new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC');
const statusNames = { working: 'Working', running: 'Running', idle: 'Idle', finished: 'Finished', paused: 'Paused', waiting: 'Waiting', waiting_for_confirmation: 'Waiting for confirmation', offline: 'Offline', error: 'Error', stuck: 'Stuck', unknown: 'Unknown' };
const statusName = value => Object.hasOwn(statusNames, value) ? statusNames[value] : 'Unknown';

function duration(start, end) {
  if (end === null) return 'Result not observed';
  const milliseconds = time(end) - time(start);
  if (!milliseconds) return 'Instant';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60000);
  return `${minutes}m ${Math.floor(milliseconds / 1000) % 60}s`;
}

function checkedList(value) {
  if (!object(value) || !Array.isArray(value.conversations) || !Array.isArray(value.warnings) ||
      value.conversations.some(item => !object(item) || typeof item.id !== 'string' || !item.id)) throw new Error('Invalid conversation list');
  return value;
}

function checkedSnapshot(value) {
  if (!object(value) || !Array.isArray(value.spans) || !Array.isArray(value.untimedEvents) || !Array.isArray(value.warnings) ||
      !Number.isSafeInteger(value.eventCount) || value.eventCount < 0 ||
      value.spans.some(span => !object(span) || typeof span.id !== 'string' || !span.id || !kinds.includes(span.kind) ||
        time(span.startedAt) === null || (span.endedAt !== null && (time(span.endedAt) === null || time(span.endedAt) < time(span.startedAt)))) ||
      value.untimedEvents.some(event => !object(event) || typeof event.id !== 'string' || !event.id)) throw new Error('Invalid conversation data');
  return value;
}

/** Mount a read-only view. Cleanup is synchronous; late client responses are ignored. */
function mountPage({ container, client, backendLabel }) {
  const document = container.ownerDocument;
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const node = (tag, className, value, attributes = {}) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    for (const [name, attribute] of Object.entries(attributes)) element.setAttribute(name, String(attribute));
    return element;
  };
  const append = (parent, ...children) => { parent.append(...children); return parent; };
  const button = (label, action, id = '') => node('button', '', label, { type: 'button', 'data-action': action, 'data-id': id });
  const empty = value => node('p', 'empty', value);
  const style = node('style', '', styles);
  const app = node('main', 'app', undefined, { 'aria-label': 'Runward conversation activity' });
  const picker = node('select', '', undefined, { id: 'conversation', 'aria-label': 'Conversation' });
  picker.append(node('option', '', 'Loading conversations…', { value: '' }));
  const refreshButton = button('Refresh', 'refresh');
  const autoInput = node('input', '', undefined, { type: 'checkbox', 'data-control': 'auto' });
  const freshness = node('p', 'freshness', 'Loading conversations…', { role: 'status', 'aria-live': 'polite' });
  const errorNotice = node('p', 'error', '', { role: 'alert' });
  errorNotice.hidden = true;
  const offsetInput = node('input', '', undefined, { id: 'utc-offset', type: 'text', placeholder: '+00:00', maxlength: '6', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'offset-help offset-error' });
  const offsetForm = node('form', 'offset-form');
  const applyButton = node('button', '', 'Apply', { type: 'submit' });
  append(offsetForm, append(node('div', 'field'), node('label', '', 'Server UTC offset', { for: 'utc-offset' }), offsetInput), applyButton);
  const timingTitle = node('h2', '', 'Timestamps');
  const timingCopy = node('p', 'timing-copy', '', { id: 'offset-help' });
  const offsetError = node('p', 'offset-error', '', { id: 'offset-error', role: 'alert' });
  offsetError.hidden = true;
  const timingDetails = append(node('details'), node('summary', '', 'Which offset should I use?'), node('p', '', 'Enter the server’s UTC offset at the time the events were recorded, such as +05:30 or -04:00. This is a fixed offset, not a timezone: daylight-saving changes and historical offset changes are not resolved. Timezone-aware originals keep their reported timezone. Leave the field blank and Apply to clear the assumption.'));
  const facts = node('div', 'facts', undefined, { 'aria-label': 'Conversation summary' });
  const warnings = node('details', 'warnings');
  warnings.hidden = true;
  const warningSummary = node('summary');
  const warningList = node('ul');
  append(warnings, warningSummary, warningList);
  const waterfall = node('div', 'waterfall', undefined, { tabindex: '0', 'aria-label': 'Shared-clock waterfall, UTC' });
  const waterfallCount = node('span', 'count');
  const waterfallNote = node('p', 'section-note');
  const legend = node('div', 'legend', undefined, { 'aria-label': 'Event kinds' });
  for (const kind of kinds) append(legend, append(node('span', 'legend-item'), node('i', `legend-mark kind-${kind}`, undefined, { 'aria-hidden': 'true' }), node('span', '', kindNames[kind])));
  const consoleList = node('div', 'console', undefined, { tabindex: '0', 'aria-label': 'Timed event console' });
  const consoleCount = node('span', 'count');
  const moreEvents = button('Show more events', 'more-events');
  moreEvents.className = 'more';
  const detailTitle = node('h3', '', 'Select an event');
  const detailMeta = node('dl', 'detail-meta');
  const detailPre = node('pre', 'detail-pre', 'Select a timeline segment or an event below to inspect its recorded detail.', { tabindex: '0', 'aria-label': 'Recorded event detail' });
  const untimedPanel = node('section', 'panel untimed-panel', undefined, { 'aria-labelledby': 'untimed-heading' });
  const untimedCount = node('span', 'count');
  const untimedList = node('ul', 'untimed-list', undefined, { tabindex: '0', 'aria-label': 'Events without resolved time' });
  const moreUntimed = button('Show more untimed events', 'more-untimed');
  moreUntimed.className = 'more';
  append(untimedPanel, append(node('div', 'panel-heading'), append(node('h2', '', 'Untimed events', { id: 'untimed-heading' }), untimedCount)), node('p', 'section-note', 'These records have no resolved UTC time. Their original timestamp text is shown without assuming the server’s timezone.'), untimedList, moreUntimed);
  append(app,
    append(node('header', 'topbar'), append(node('span', 'brand'), node('span', 'brand-mark', '→', { 'aria-hidden': 'true' }), node('span', '', 'runward')), node('span', 'backend', text(backendLabel, 'OpenHands')), node('span', 'badge', 'Read only')),
    append(node('div', 'heading'), append(node('div'), node('h1', '', 'Conversation activity'), node('p', '', 'Inspect recorded work on a shared clock.'))),
    append(node('div', 'toolbar'), append(node('div', 'field'), node('label', '', 'Conversation', { for: 'conversation' }), picker), append(node('div', 'actions'), refreshButton, append(node('label', 'auto-refresh'), autoInput, node('span', '', 'Refresh every 5s')))),
    freshness, errorNotice,
    append(node('section', 'timing', undefined, { 'aria-label': 'Timestamp interpretation' }), append(node('div', 'timing-heading'), timingTitle, offsetForm), timingCopy, offsetError, timingDetails),
    facts, warnings,
    append(node('section', 'panel', undefined, { 'aria-labelledby': 'waterfall-heading' }), append(node('div', 'panel-heading'), append(node('h2', '', 'Activity waterfall', { id: 'waterfall-heading' }), waterfallCount)), waterfallNote, waterfall, legend),
    untimedPanel,
    append(node('div', 'lower-grid'),
      append(node('section', 'panel', undefined, { 'aria-labelledby': 'console-heading' }), append(node('div', 'panel-heading'), append(node('h2', '', 'Event console', { id: 'console-heading' }), consoleCount)), consoleList, moreEvents),
      append(node('section', 'panel', undefined, { 'aria-labelledby': 'detail-heading' }), append(node('div', 'panel-heading'), node('h2', '', 'Event detail', { id: 'detail-heading' })), append(node('div', 'detail-content'), detailTitle, detailMeta, detailPre))),
    node('p', 'footer', 'Read-only observations. An open tool means its result was not observed; it does not prove the tool is still running.'));
  root.append(style, app);
  container.append(host);

  const state = { conversations: [], listWarnings: [], listLoaded: false, selectedId: '', selectedEvent: '', offset: '', snapshot: null, updatedAt: 0, auto: false, eventLimit: 100, untimedLimit: 100 };
  let disposed = false;
  let busy = false;
  let version = 0;
  let pending = null;
  let timer;
  let focusTargets = new Map();
  let detailEventId = '';

  function setError(message = '') {
    errorNotice.textContent = message;
    errorNotice.hidden = !message;
  }

  function renderOptions() {
    const options = state.conversations.map(item => ({ id: item.id, label: `${text(item.title, item.id)} · ${statusName(item.status)}` }));
    if (!options.length) options.push({ id: '', label: 'No conversations available' });
    // Keep the select and unchanged options intact while the user is navigating them.
    const previous = [...picker.options].map(option => ({ id: option.value, label: option.textContent }));
    if (JSON.stringify(options) !== JSON.stringify(previous)) picker.replaceChildren(...options.map(option => node('option', '', option.label, { value: option.id })));
    picker.value = state.selectedId;
    picker.disabled = !state.conversations.length;
  }

  function eventButton(span, className, focusKey) {
    const element = button(text(span.label, 'Recorded event'), 'select-event', span.id);
    element.className = `${className} kind-${span.kind}`;
    element.dataset.focus = focusKey;
    element.setAttribute('aria-pressed', String(state.selectedEvent === span.id));
    focusTargets.set(focusKey, element);
    return element;
  }

  function renderWaterfall(spans) {
    waterfallCount.textContent = String(spans.length);
    waterfallNote.textContent = 'UTC · grouped by event kind, not separate agents. Dotted markers have no observed result; their duration is unknown.';
    waterfall.replaceChildren();
    if (!spans.length) {
      waterfall.append(empty(state.snapshot?.data.untimedEvents.length
        ? 'No resolved timeline yet. Review untimed records below or apply the server’s UTC offset.'
        : state.snapshot ? 'No timestamped spans in this conversation.' : state.selectedId ? 'Loading conversation activity…' : 'Select a conversation to inspect its activity.'));
      return;
    }
    const ordered = [...spans].sort((a, b) => time(a.startedAt) - time(b.startedAt));
    const minimum = Math.min(...ordered.map(span => time(span.startedAt)));
    const maximum = Math.max(...ordered.map(span => time(span.endedAt) ?? time(span.startedAt)));
    const range = Math.max(1, maximum - minimum);
    append(waterfall, append(node('div', 'axis'), node('span', '', 'UTC'), append(node('div', 'axis-times'), node('span', '', clock(minimum)), node('span', 'axis-mid', clock(minimum + range / 2)), node('span', '', clock(maximum)))));
    const shown = ordered.slice(0, 300);
    if (shown.length < ordered.length) waterfallNote.textContent += ' Showing the first 300 spans; the event console includes the remaining spans.';
    for (const kind of kinds) {
      const matching = shown.filter(span => span.kind === kind);
      if (!matching.length) continue;
      const tracks = [];
      for (const span of matching) {
        const started = time(span.startedAt);
        const ended = time(span.endedAt) ?? started;
        let track = tracks.find(item => item.end < started);
        if (!track) { track = { end: -Infinity, spans: [] }; tracks.push(track); }
        track.spans.push(span);
        track.end = ended;
      }
      const trackGroup = node('div');
      for (const track of tracks) {
        const lane = node('div', 'lane-track');
        for (const span of track.spans) {
          const mark = eventButton(span, `span-mark${span.endedAt === null ? ' open' : ''}`, `waterfall:${span.id}`);
          mark.textContent = '';
          const left = 100 * (time(span.startedAt) - minimum) / range;
          const width = Math.max(0, 100 * ((time(span.endedAt) ?? time(span.startedAt)) - time(span.startedAt)) / range);
          // Keep instant markers at the right boundary inside the scroll area.
          mark.style.left = `min(${left}%, calc(100% - 7px))`;
          mark.style.width = `${Math.min(100 - left, width)}%`;
          const label = `${text(span.label, kindNames[kind])} · ${dateTime(span.startedAt)} · ${duration(span.startedAt, span.endedAt)}`;
          mark.setAttribute('aria-label', label);
          mark.title = label;
          lane.append(mark);
        }
        trackGroup.append(lane);
      }
      waterfall.append(append(node('div', 'lane'), node('span', 'lane-name', kindNames[kind]), trackGroup));
    }
  }

  function renderDetail() {
    const span = state.snapshot?.data.spans.find(item => item.id === state.selectedEvent);
    detailTitle.textContent = span ? text(span.label, 'Recorded event') : 'Select an event';
    detailMeta.replaceChildren();
    if (span) for (const [key, value] of [['Kind', kindNames[span.kind]], ['Event ID', span.id], ['Started', dateTime(span.startedAt)], ['Ended', span.endedAt === null ? 'Not observed' : dateTime(span.endedAt)], ['Duration', duration(span.startedAt, span.endedAt)]]) append(detailMeta, node('dt', '', key), node('dd', '', value));
    const scroll = detailEventId === span?.id ? detailPre.scrollTop : 0;
    detailPre.textContent = span ? text(span.detail, 'No readable detail was recorded.') : 'Select a timeline segment or an event to inspect its recorded detail.';
    detailPre.scrollTop = scroll;
    detailEventId = span?.id ?? '';
  }

  function render() {
    if (disposed) return;
    const focus = root.activeElement?.dataset.focus;
    const scrolls = [waterfall, consoleList, untimedList].map(element => element.scrollTop);
    focusTargets = new Map();
    const data = state.snapshot?.data;
    const spans = data?.spans ?? [];
    if (!spans.some(span => span.id === state.selectedEvent)) state.selectedEvent = '';
    const assumption = state.snapshot?.offset ?? state.offset;
    timingTitle.textContent = data?.timingBasis === 'fixed-offset' ? 'User-supplied fixed UTC offset' : 'Timestamps';
    timingCopy.textContent = assumption
      ? `User-supplied fixed UTC offset ${assumption}. It is applied only to timestamps without a timezone; timezone-aware originals remain unchanged. Daylight-saving and historical changes are not resolved.`
      : 'No UTC offset applied. Timestamps without a timezone remain untimed. Enter the server’s recorded offset and Apply to place those events on the timeline.';
    const combinedWarnings = [...state.listWarnings, ...(data?.warnings ?? [])].filter(value => typeof value === 'string' && value);
    warnings.hidden = !combinedWarnings.length;
    warningSummary.textContent = `${combinedWarnings.length} ${combinedWarnings.length === 1 ? 'warning' : 'warnings'}`;
    warningList.replaceChildren(...combinedWarnings.map(value => node('li', '', value)));
    facts.replaceChildren(...[[data?.eventCount ?? '—', 'source events'], [spans.length, 'timed spans'], [data?.untimedEvents.length ?? 0, 'untimed events'], [statusName(data?.status), 'recorded status']].map(([value, label]) => append(node('div', 'fact'), node('strong', '', value), node('span', '', label))));
    renderWaterfall(spans);
    consoleCount.textContent = String(spans.length);
    consoleList.replaceChildren();
    const ordered = [...spans].sort((a, b) => time(a.startedAt) - time(b.startedAt));
    for (const span of ordered.slice(0, state.eventLimit)) {
      const trigger = eventButton(span, 'event-button', `console:${span.id}`);
      trigger.replaceChildren(node('i', `legend-mark kind-${span.kind}`, undefined, { 'aria-hidden': 'true' }), node('span', 'event-label', text(span.label, 'Recorded event')));
      const preview = text(span.detail);
      consoleList.append(append(node('div', 'event-item'), trigger, node('p', 'event-meta', `${dateTime(span.startedAt)} · ${duration(span.startedAt, span.endedAt)}`), node('p', 'event-preview', preview.length > 180 ? `${preview.slice(0, 180)}…` : preview)));
    }
    if (!spans.length) consoleList.append(empty(data?.untimedEvents.length ? 'Untimed event metadata is available above.' : 'No timed events to inspect.'));
    moreEvents.hidden = state.eventLimit >= spans.length;
    moreEvents.textContent = `Show more events (${Math.min(state.eventLimit, spans.length)} of ${spans.length})`;
    const untimed = data?.untimedEvents ?? [];
    untimedPanel.hidden = !untimed.length;
    untimedCount.textContent = String(untimed.length);
    untimedList.replaceChildren(...untimed.slice(0, state.untimedLimit).map(event => append(node('li', 'untimed-item'), node('span', 'untimed-kind', kindNames[event.kind] ?? text(event.kind, 'Unknown')), node('span', '', text(event.label, 'Recorded event')), node('span', 'untimed-time', `Original timestamp: ${text(event.rawTimestamp, 'Not recorded')} · ID: ${event.id}`))));
    moreUntimed.hidden = state.untimedLimit >= untimed.length;
    moreUntimed.textContent = `Show more untimed events (${Math.min(state.untimedLimit, untimed.length)} of ${untimed.length})`;
    renderDetail();
    [waterfall, consoleList, untimedList].forEach((element, index) => { element.scrollTop = scrolls[index]; });
    if (focus) (focusTargets.get(focus) ?? (focus.startsWith('waterfall:') ? waterfall : consoleList)).focus({ preventScroll: true });
  }

  function showProgress() {
    if (disposed) return;
    refreshButton.setAttribute('aria-disabled', String(busy));
    refreshButton.textContent = busy ? 'Refreshing…' : 'Refresh';
    app.setAttribute('aria-busy', String(busy));
    if (busy) freshness.textContent = state.snapshot ? 'Refreshing… showing the previous snapshot until the next response.' : state.listLoaded ? 'Loading conversation activity…' : 'Loading conversations…';
    else freshness.textContent = state.updatedAt ? `Last refreshed ${clock(state.updatedAt)} UTC · ${state.auto ? 'automatic refresh enabled' : 'manual refresh'}` : state.listLoaded && !state.conversations.length ? 'No conversations available. Start or select a conversation in your backend, then Refresh.' : 'No snapshot received. Use Refresh to try again.';
  }

  function schedule() {
    clearTimeout(timer);
    if (!disposed && state.auto && !busy) timer = setTimeout(() => request(true), 5000);
  }

  async function drain() {
    if (busy || disposed) return;
    busy = true;
    showProgress();
    while (pending && !disposed) {
      const job = pending;
      pending = null;
      const current = () => !disposed && version === job.version;
      let phase = 'conversations';
      try {
        if (job.list) {
          const result = checkedList(await client.listConversations({ isActive: current }));
          if (!current()) continue;
          state.conversations = result.conversations;
          state.listWarnings = result.warnings;
          state.listLoaded = true;
          if (!state.conversations.some(item => item.id === state.selectedId)) {
            state.selectedId = state.conversations[0]?.id ?? '';
            state.snapshot = null;
            state.selectedEvent = '';
            state.updatedAt = 0;
            state.eventLimit = state.untimedLimit = 100;
          }
          renderOptions();
          render();
        }
        if (!state.selectedId) { setError(); continue; }
        phase = 'activity';
        const id = state.selectedId;
        const utcOffset = state.offset;
        const result = checkedSnapshot(await client.readConversation(id, { utcOffset, isActive: current }));
        if (!current()) continue;
        state.snapshot = { data: result, offset: utcOffset };
        state.updatedAt = Date.now();
        setError();
        render();
      } catch {
        if (current()) setError(`Could not load ${phase}. Check the backend connection and version, then Refresh to try again.${state.snapshot ? ' The previous snapshot is still shown.' : ''}`);
      }
    }
    busy = false;
    showProgress();
    schedule();
  }

  function request(list = false) {
    if (disposed) return;
    clearTimeout(timer);
    pending = { version: ++version, list: list || !state.listLoaded || Boolean(pending?.list) };
    void drain();
  }

  function click(event) {
    const target = event.target.closest?.('button[data-action]');
    if (!target || disposed) return;
    switch (target.dataset.action) {
      case 'refresh': if (!busy) request(true); break;
      case 'select-event':
        state.selectedEvent = target.dataset.id;
        for (const element of root.querySelectorAll('button[data-action="select-event"]')) element.setAttribute('aria-pressed', String(element.dataset.id === state.selectedEvent));
        renderDetail();
        break;
      case 'more-events': state.eventLimit += 100; render(); if (moreEvents.hidden) consoleList.focus({ preventScroll: true }); break;
      case 'more-untimed': state.untimedLimit += 100; render(); if (moreUntimed.hidden) untimedList.focus({ preventScroll: true }); break;
    }
  }

  function change(event) {
    if (disposed) return;
    if (event.target === picker) {
      state.selectedId = picker.value;
      state.selectedEvent = '';
      state.snapshot = null;
      state.updatedAt = 0;
      state.eventLimit = state.untimedLimit = 100;
      setError();
      render();
      request();
    } else if (event.target === autoInput) {
      state.auto = autoInput.checked;
      schedule();
      showProgress();
    }
  }

  function submit(event) {
    if (event.target !== offsetForm || disposed) return;
    event.preventDefault();
    const offset = offsetInput.value.trim();
    if (offset && (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/u.test(offset) || /^[+-]14:(?!00)/u.test(offset))) {
      offsetError.textContent = 'Use a fixed UTC offset from -14:00 to +14:00, such as +05:30, or leave it blank.';
      offsetError.hidden = false;
      offsetInput.setAttribute('aria-invalid', 'true');
      offsetInput.focus();
      return;
    }
    offsetError.hidden = true;
    offsetInput.removeAttribute('aria-invalid');
    state.offset = offset;
    request();
  }

  root.addEventListener('click', click);
  root.addEventListener('change', change);
  root.addEventListener('submit', submit);
  render();
  request(true);
  return () => {
    if (disposed) return;
    disposed = true;
    version += 1;
    pending = null;
    clearTimeout(timer);
    root.removeEventListener('click', click);
    root.removeEventListener('change', change);
    root.removeEventListener('submit', submit);
    focusTargets.clear();
    host.remove();
  };
}
return { mountPage };
})();

export function activate(host) {
  if (host?.apiVersion !== '1' || typeof host.registerPage !== 'function' || typeof host.agentServer?.request !== 'function') {
    throw new Error('Runward requires Canvas host API 1 with an authenticated Agent Server request helper.');
  }
  return host.registerPage('timeline', ({ container }) => mountPage({
    container,
    client: createClient(options => host.agentServer.request(options)),
    backendLabel: typeof host.backend?.id === 'string' ? host.backend.id : 'Active backend',
  }));
}
