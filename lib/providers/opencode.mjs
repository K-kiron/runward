const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0;
const streamTypes = new Set(['text', 'reasoning', 'tool_use', 'step_start', 'step_finish', 'error']);

/** Read explicit OpenCode v1/v2 exports or `run --format json` output without opening its referenced files. */
export function readOpenCode(text, { warn, timestamp, milliseconds, jsonRecords }) {
  const result = { events: [] };
  const spans = new Map();
  const settledTools = new Set();
  const date = value => typeof value === 'number' ? milliseconds(value) : timestamp(value);
  let lifecycleAt;
  let approximate = false;
  const seenAt = value => {
    const at = date(value);
    if (at && (!result.lastSeen || at > result.lastSeen)) result.lastSeen = at;
    return at;
  };
  const session = id => {
    if (!identifier(id)) { warn('OpenCode record without an explicit session ID skipped.'); return false; }
    if (result.sessionId && id !== result.sessionId) {
      warn('OpenCode record belongs to another session; only the first explicit session is imported.');
      return false;
    }
    result.sessionId = id;
    return true;
  };
  const belongs = value => !identifier(value?.sessionID) || value.sessionID === result.sessionId;
  const lifecycle = (status, at) => {
    if (at && (!lifecycleAt || at >= lifecycleAt)) { result.status = status; lifecycleAt = at; }
  };
  const add = event => {
    if (!identifier(event.id)) { warn('OpenCode part without a stable producer ID skipped.'); return; }
    if (!event.startedAt) { warn('OpenCode event without a valid timestamp skipped.'); return; }
    seenAt(event.startedAt);
    seenAt(event.endedAt);
    const previous = spans.get(event.id);
    // Repeated snapshots must not turn a settled tool back into an open interval.
    if (previous?.endedAt && (!event.endedAt || previous.endedAt > event.endedAt)) return;
    spans.set(event.id, event);
  };
  const instant = (id, kind, label, detail, at) => add({ id, kind, label, detail, startedAt: at, endedAt: at });
  const timing = (startValue, endValue, observedAt, open) => {
    const startedAt = date(startValue);
    const endedAt = date(endValue);
    if (startedAt && endedAt && endedAt >= startedAt) return { startedAt, endedAt };
    if (startedAt && endValue === undefined && open) return { startedAt, endedAt: null };
    approximate = true;
    if (endValue !== undefined && (!endedAt || (startedAt && endedAt < startedAt))) {
      warn('OpenCode event has invalid or reversed timing; no duration inferred.');
    }
    const at = endedAt && !startedAt ? endedAt : startedAt ?? observedAt;
    return { startedAt: at, endedAt: at };
  };
  const tool = (part, key, observedAt, modern = false) => {
    if (!object(part.state)) { warn('OpenCode tool part has no state; skipped.'); return; }
    const state = part.state;
    if (!['pending', 'streaming', 'running', 'completed', 'error'].includes(state.status)) {
      warn('OpenCode tool has an unsupported state; skipped.'); return;
    }
    const name = modern ? part.name : part.tool;
    const pending = state.status === 'pending' || state.status === 'streaming';
    const open = pending || state.status === 'running';
    if (open && settledTools.has(key)) return;
    const times = modern ? part.time : state.time;
    const start = modern ? times?.ran ?? times?.created : times?.start;
    const end = modern ? times?.completed : times?.end;
    const interval = timing(start, end, observedAt, open);
    if (!open && interval.startedAt) settledTools.add(key);
    const delegated = name === 'task' || name === 'subagent';
    add({ id: key, kind: state.status === 'error' ? 'error' : delegated ? 'subagent' : 'tool',
      label: `${pending ? 'Pending tool: ' : ''}${identifier(name) ? name : 'Tool call'}`, ...interval,
      detail: { status: state.status, input: state.input, output: modern ? state.content : state.output,
        error: state.error, metadata: state.metadata, callID: modern ? part.id : part.callID ?? part.id } });
  };
  const legacyPart = (part, observedAt, role) => {
    if (!object(part)) { warn('Malformed OpenCode part skipped.'); return; }
    if (!belongs(part)) { warn('OpenCode part belongs to another session; skipped.'); return; }
    const id = part.partID ?? part.id;
    if (!identifier(id)) { warn('OpenCode part without a stable producer ID skipped.'); return; }
    const key = `part:${id}`;
    if (part.type === 'tool') { tool(part, key, observedAt); return; }
    if (part.type === 'text' || part.type === 'reasoning') {
      if (typeof part.text !== 'string') { warn('Malformed OpenCode text or reasoning part skipped.'); return; }
      const interval = timing(part.time?.start, part.time?.end, observedAt, Boolean(part.time));
      add({ id: key, kind: part.type === 'reasoning' ? 'thinking' : 'message',
        label: part.type === 'reasoning' ? 'Reasoning' : role === 'user' ? 'User message' : 'Assistant message',
        detail: part.text, ...interval });
    } else if (part.type === 'subtask') {
      instant(key, 'subagent', 'Subtask request', { agent: part.agent, description: part.description, prompt: part.prompt }, observedAt);
    } else if (part.type === 'retry') {
      instant(key, 'error', 'Retry after error', part.error, date(part.time?.created) ?? observedAt);
    } else if (part.type === 'step-start' || part.type === 'step-finish') {
      instant(key, 'message', part.type === 'step-start' ? 'Step started' : 'Step finished', { reason: part.reason }, observedAt);
    }
  };
  const message = item => {
    if (!object(item)) { warn('Malformed OpenCode message skipped.'); return; }
    if (object(item.info) && Array.isArray(item.parts)) {
      const info = item.info;
      if (!belongs(info)) { warn('OpenCode message belongs to another session; skipped.'); return; }
      const created = seenAt(info.time?.created);
      const completed = seenAt(info.time?.completed);
      for (const part of item.parts) legacyPart(part, part?.type === 'step-finish' ? completed ?? created : created, info.role);
      if (info.error && identifier(info.id)) instant(`message:${info.id}:error`, 'error', 'Assistant error', info.error, completed ?? created);
      return;
    }
    if (!identifier(item.id)) { warn('OpenCode message without a stable producer ID skipped.'); return; }
    if (!belongs(item)) { warn('OpenCode message belongs to another session; skipped.'); return; }
    const created = seenAt(item.time?.created);
    const completed = seenAt(item.time?.completed);
    const key = `message:${item.id}`;
    if (item.type === 'assistant') {
      if (!Array.isArray(item.content)) { warn('Malformed OpenCode assistant content skipped.'); return; }
      item.content.forEach((part, index) => {
        if (!object(part)) { warn('Malformed OpenCode assistant part skipped.'); return; }
        if (part.type === 'tool') {
          if (!identifier(part.id)) { warn('OpenCode tool without a stable producer ID skipped.'); return; }
          tool(part, `${key}:tool:${part.id}`, created, true);
        } else if (part.type === 'reasoning' && typeof part.text === 'string') {
          add({ id: `${key}:reasoning:${index}`, kind: 'thinking', label: 'Reasoning', detail: part.text,
            ...timing(part.time?.created, part.time?.completed, completed ?? created, Boolean(part.time)) });
        } else if (part.type === 'text' && typeof part.text === 'string') {
          approximate = true;
          instant(`${key}:text:${index}`, 'message', 'Assistant message', part.text, completed ?? created);
        }
      });
      if (item.error) instant(`${key}:error`, 'error', 'Assistant error', item.error, completed ?? created);
    } else if (['user', 'system', 'synthetic', 'skill'].includes(item.type) && typeof item.text === 'string') {
      instant(key, 'message', `${item.type[0].toUpperCase()}${item.type.slice(1)} message`, item.text, created);
    } else if (item.type === 'idle') {
      if (!['succeeded', 'failed', 'interrupted'].includes(item.outcome)) { warn('OpenCode idle marker has an unsupported outcome; skipped.'); return; }
      lifecycle('idle', created);
      instant(key, item.outcome === 'succeeded' ? 'message' : 'error', 'Session idle', { outcome: item.outcome, error: item.error }, created);
    } else if (item.type === 'shell') {
      add({ id: key, kind: item.status === 'failed' || (Number.isInteger(item.exit) && item.exit !== 0) ? 'error' : 'tool',
        label: 'Shell command', detail: { command: item.command, status: item.status, exit: item.exit, output: item.output },
        ...timing(item.time?.created, item.time?.completed, created, item.status === 'running') });
    } else if (item.type === 'compaction') {
      instant(key, item.status === 'failed' ? 'error' : 'message', 'Context compaction', { status: item.status, summary: item.summary, error: item.error }, created);
    }
  };

  for (const row of jsonRecords(text, warn)) {
    if (!object(row)) { warn('Expected an OpenCode JSON object; skipped.'); continue; }
    if (object(row.info) && Array.isArray(row.messages)) {
      if (!session(row.info.id)) continue;
      const info = row.info;
      if (typeof info.title === 'string' && info.title) result.name = info.title;
      const cwd = info.location?.directory ?? info.directory;
      if (typeof cwd === 'string') result.cwd = cwd;
      const created = date(info.time?.created);
      if (created && (!result.startedAt || created < result.startedAt)) result.startedAt = created;
      seenAt(info.time?.updated);
      const busy = date(info.time?.busy);
      const idle = date(info.time?.idle);
      if (busy && (!idle || busy > idle)) lifecycle('working', busy);
      else if (idle) lifecycle('idle', idle);
      for (const item of row.messages) message(item);
    } else if (streamTypes.has(row.type)) {
      if (!session(row.sessionID)) continue;
      if (object(row.part) && !belongs(row.part)) { warn('OpenCode part belongs to another session; skipped.'); continue; }
      const at = date(row.timestamp);
      if (!at) { warn('OpenCode stream record without a valid timestamp skipped.'); continue; }
      seenAt(at);
      if (row.type === 'error') {
        instant(`error:${at}:${JSON.stringify(row.error)}`, 'error', 'Session error', row.error, at);
      } else if (object(row.part)) {
        legacyPart(row.part, at, 'assistant');
      } else warn('OpenCode stream record without a part skipped.');
    }
  }
  result.events = [...spans.values()];
  if (approximate) warn('OpenCode events without their own complete intervals use recorded timestamps as instants; no duration inferred.');
  return result;
}
