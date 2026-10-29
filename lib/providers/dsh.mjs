// DeepSeek Harness session format 4, verified against f3803c96974ad4a94195fb97e5c637e9c2a3afe3.
// This is an observation reader, not a session replay engine. All content is untrusted.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const nonempty = value => typeof value === 'string' && value.length > 0;
const knownOmitted = new Set(['step/start', 'step/end', 'session/end-seed', 'request/header',
  'agent/inbox/spliced', 'agent-preset/selected', 'approval/asked', 'approval/decided', 'approval/policy',
  'compaction/prune', 'compaction/summary', 'deliverables/presented', 'feedback/message-delete',
  'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'image/offload',
  'job/registered', 'job/settled', 'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset',
  'plan/mode', 'sandbox/mode', 'schedule/change', 'session/title-llm-request',
  'session-log-deepseek/delivery-accepted', 'subagent/model-selection-policy', 'team/member',
  'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
  'tool-workflow/run-start', 'web/deepseek-search-llm-request', 'workspace/changes']);

/** Read one decompressed session.v4.jsonl, including the canonical ZIP export. */
export function readDsh(text, { warn, milliseconds, jsonRecords }) {
  const records = jsonRecords(text, warn);
  const header = records[0];
  const result = { events: [] };
  if (!object(header) || header.type !== 'session' || header.version !== 4) {
    warn('DSH requires a session header with supported format version 4.');
    return result;
  }
  if (!nonempty(header.id) || typeof header.isSeeded !== 'boolean' || !count(header.createdAt)) {
    warn('DSH session header has missing or invalid identity, seed flag, or creation time.');
    return result;
  }
  result.sessionId = header.id;
  result.cwd = typeof header.cwd === 'string' ? header.cwd : undefined;
  result.startedAt = milliseconds(header.createdAt);
  if (!result.startedAt) warn('DSH session creation timestamp is invalid.');
  result.lastSeen = result.startedAt;
  const id = (...parts) => JSON.stringify([header.id, ...parts]);
  const touch = time => {
    const at = count(time) ? milliseconds(time) : null;
    if (at && (!result.lastSeen || at > result.lastSeen)) result.lastSeen = at;
    return at;
  };
  const instant = (eventId, kind, label, at, detail) => {
    if (at) result.events.push({ id: eventId, kind, label, startedAt: at, endedAt: at, detail });
  };
  const rows = [];
  for (const row of records.slice(1)) {
    if (object(row) && count(row.seq) && row.seq < rows.length && JSON.stringify(rows[row.seq]) === JSON.stringify(row)) continue;
    if (!object(row) || !count(row.seq) || row.seq !== rows.length || !object(row.data) || typeof row.type !== 'string') {
      warn('DSH invalid event or sequence gap: the remaining suffix was not imported.');
      break;
    }
    rows.push(row);
  }
  const inheritedCut = rows.findLastIndex(row => row.type === 'session/end-seed' && row.data.inherited === true);
  if (!header.isSeeded && inheritedCut !== -1) {
    warn('DSH unseeded header conflicts with an inherited-history marker; events were deferred.');
    return result;
  }
  const cut = header.isSeeded ? inheritedCut : 0;
  if (cut === -1) {
    warn('DSH inherited-history boundary is not yet present; events were deferred.');
    return result;
  }
  if (header.isSeeded) warn('DSH inherited events before the last tagged seed boundary were excluded.');
  const pairs = new Map();
  const pair = (namespace, key, side, row, at, label, detail, error = false, laneId) => {
    if (!nonempty(key)) { warn(`DSH ${row.type} has no pairing ID; skipped.`); return; }
    const eventId = id(namespace, key);
    const entry = pairs.get(eventId) ?? { id: eventId, label, laneId };
    if (entry[side]) { warn(`DSH duplicate ${namespace} ${side} was ignored.`); return; }
    entry[side] = { at, detail, error };
    if (side === 'start') { entry.label = label; entry.laneId = laneId; }
    pairs.set(eventId, entry);
  };
  const usage = data => {
    if (!object(data) || !count(data.inputTokens)) return;
    const parts = [data.inputTokens, data.cacheReadTokens ?? 0, data.cacheWriteTokens ?? 0];
    if (parts.every(count) && Number.isSafeInteger(parts.reduce((sum, n) => sum + n, 0))) {
      result.contextUsed = parts.reduce((sum, n) => sum + n, 0);
    }
  };
  for (const row of rows.slice(cut)) {
    const data = row.data;
    const at = touch(row.time);
    if (!at) warn(`DSH event ${row.seq} has a missing or invalid timestamp.`);
    switch (row.type) {
      case 'session/title': if (nonempty(data.title)) result.name = data.title; break;
      case 'working-directory/change': if (typeof data.cwd === 'string') result.cwd = data.cwd; break;
      case 'request/context': if (count(data.contextWindow) && data.contextWindow > 0) result.contextLimit = data.contextWindow; break;
      case 'turn/start': result.status = at ? 'working' : undefined; break;
      case 'turn/end': {
        const reason = data.reason?.kind;
        result.status = at ? (reason === 'blocked' ? 'waiting' : ['completed', 'aborted', 'error', 'max-tokens', 'interrupted', 'forked'].includes(reason) ? 'idle' : undefined) : undefined;
        if (reason === 'error') instant(id('event', row.seq), 'error', 'Turn error', at, data.reason.error);
        break;
      }
      case 'tool/call': pair('tool', data.callId, 'start', row, at, data.name || 'Tool', data.arguments); break;
      case 'tool/result': pair('tool', data.message?.toolCallId, 'end', row, at, 'Tool result', data, data.message?.isError === true); break;
      case 'tool/ptc-dispatch-start': pair('ptc', data.subCallId, 'start', row, at, data.name || 'Nested tool', data.arguments, false, `tool:${data.parentCallId}`); break;
      case 'tool/ptc-dispatch': pair('ptc', data.subCallId, 'end', row, at, data.name || 'Nested tool', data, data.isError === true, `tool:${data.parentCallId}`); break;
      case 'command/run': pair('command', data.commandId, 'start', row, at, `/${data.name || 'command'}`, data.args); break;
      case 'command/done': pair('command', data.commandId, 'end', row, at, 'Command result', data, data.kind === 'error'); break;
      case 'compaction/start': pair('compaction', data.compactionId, 'start', row, at, 'Context compaction', data); break;
      case 'compaction/end': pair('compaction', data.compactionId, 'end', row, at, 'Context compaction', data, typeof data.error === 'string'); break;
      case 'subagent/catalog':
      case 'subagent/descriptor': instant(id('event', row.seq), 'subagent', data.label || row.type, at, data); break;
      case 'user/message': instant(id('event', row.seq), 'message', 'User message', at, data); break;
      case 'system/message':
      case 'developer/message': instant(id('event', row.seq), 'message', row.type === 'system/message' ? 'System message' : 'Developer message', at, data.message); break;
      case 'assistant/message':
      case 'assistant/attempt': {
        const represented = readStream(data.stream, row.seq, { id, instant, warn, touch, events: result.events, usage });
        if (Array.isArray(data.message?.content)) {
          for (const [index, block] of data.message.content.entries()) {
            if (!object(block) || block.type === 'tool-call' || represented.has(block.type)) continue;
            instant(id('event', row.seq, 'content', index), block.type === 'reasoning' ? 'thinking' : 'message',
              block.type === 'reasoning' ? 'Reasoning output' : 'Assistant message', at, block);
          }
        }
        usage(data.usage);
        break;
      }
      default: if (!knownOmitted.has(row.type)) warn(`DSH event ${row.seq}: unsupported event type was omitted.`);
    }
  }
  for (const entry of pairs.values()) {
    const start = entry.start?.at;
    const end = entry.end?.at;
    const detail = JSON.stringify({ arguments: entry.start?.detail, result: entry.end?.detail });
    if (!start) {
      warn('DSH result has no timed invocation; shown as an instant when its timestamp is available.');
      instant(entry.id, entry.end?.error ? 'error' : 'message', entry.label, end, detail);
      continue;
    }
    if (!end || end < start) warn(end ? 'DSH result predates invocation; interval left open.' : 'DSH invocation has no timed result; interval left open.');
    result.events.push({ id: entry.id, kind: entry.end?.error ? 'error' : 'tool', label: entry.label,
      startedAt: start, endedAt: end && end >= start ? end : null, detail, laneId: entry.laneId });
  }
  return result;
}

function readStream(stream, seq, { id, instant, warn, touch, events, usage }) {
  const represented = new Set();
  if (!Array.isArray(stream)) { warn(`DSH assistant event ${seq} lacks its timed stream; content uses the event timestamp.`); return represented; }
  const blocks = new Map();
  const chunk = (value, time, position) => {
    const at = touch(time);
    if (!object(value) || !at) { warn(`DSH assistant event ${seq} has an invalid timed stream chunk.`); return; }
    if (value.type === 'usage') { usage(value.usage); return; }
    if (value.type === 'finish') {
      if (value.reason?.kind === 'error') instant(id('event', seq, 'finish', position), 'error', 'Model error', at, value.reason.failure);
      return;
    }
    if (!count(value.index)) { warn(`DSH assistant event ${seq} has an invalid block index.`); return; }
    if (value.type === 'tool-call-delta') return; // Arguments being generated do not prove tool execution.
    const block = blocks.get(value.index) ?? { firstAt: at, text: '' };
    if (value.type === 'block-start') { block.start = at; block.type = value.blockType; }
    else if (value.type === 'block-end' && object(value.block)) { block.end = at; block.type = value.block.type; block.content = value.block; }
    else if (['text-delta', 'reasoning-delta'].includes(value.type) && typeof value.text === 'string') {
      block.type = value.type === 'reasoning-delta' ? 'reasoning' : 'text'; block.text += value.text;
    } else { warn(`DSH assistant event ${seq} has an unsupported stream chunk.`); return; }
    blocks.set(value.index, block);
  };
  for (const [position, record] of stream.entries()) {
    if (object(record) && record.type === 'chunk') { chunk(record.chunk, record.time, position); continue; }
    if (!object(record) || !['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record.type)) {
      warn(`DSH assistant event ${seq} has an unsupported compact stream record.`); continue;
    }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts;
    if (!count(record.time0) || !count(record.index) || !Array.isArray(members) || members.length === 0 ||
        members.some(value => typeof value !== 'string') || !Array.isArray(record.dt) || record.dt.length !== members.length - 1 ||
        record.dt.some(value => !Number.isSafeInteger(value)) || (record.type === 'tool-call-chunks' && !nonempty(record.id))) {
      warn(`DSH assistant event ${seq} has a malformed compact stream record.`); continue;
    }
    let time = record.time0;
    const times = [time];
    for (const gap of record.dt) { time += gap; times.push(time); }
    if (times.some(value => !count(value))) { warn(`DSH assistant event ${seq} has invalid compact stream timing.`); continue; }
    for (let index = 0; index < members.length; index++) {
      chunk({ type: record.type === 'text-chunks' ? 'text-delta' : record.type === 'reasoning-chunks' ? 'reasoning-delta' : 'tool-call-delta',
        index: record.index, text: members[index] }, times[index], position);
    }
  }
  for (const [index, block] of blocks) {
    if (block.type === 'tool-call') continue;
    const kind = block.type === 'reasoning' ? 'thinking' : 'message';
    const label = kind === 'thinking' ? 'Reasoning output' : 'Assistant message';
    const detail = block.content ?? { type: block.type, text: block.text };
    if (!block.start) {
      warn(`DSH assistant event ${seq} block has no explicit start; shown as an instant.`);
      instant(id('event', seq, 'block', index), kind, label, block.end ?? block.firstAt, detail);
    } else {
      if (!block.end || block.end < block.start) warn(`DSH assistant event ${seq} block has no valid end; interval left open.`);
      events.push({ id: id('event', seq, 'block', index), kind, label, startedAt: block.start,
        endedAt: block.end && block.end >= block.start ? block.end : null, detail });
    }
    represented.add(block.type);
  }
  return represented;
}
