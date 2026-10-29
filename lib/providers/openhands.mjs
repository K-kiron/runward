const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = new Set(['ActionEvent', 'ObservationEvent', 'AgentErrorEvent', 'UserRejectObservation', 'MessageEvent', 'ConversationStateUpdateEvent', 'ConversationErrorEvent', 'PauseEvent']);
const statuses = { running: 'working', idle: 'idle', finished: 'idle', paused: 'waiting', waiting_for_confirmation: 'waiting', error: 'idle', stuck: 'idle' };
const readable = content => Array.isArray(content) ? content.filter(part => object(part) && typeof part.text === 'string').map(part => part.text).join('\n') : '';

/** Read current SDK events, including the CLI's --headless --json stream. */
export function readOpenHands(text, { warn, timestamp, jsonRecords }) {
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
