import { createHash } from 'node:crypto';
import { parseAdditionalTranscript, TRANSCRIPT_PROVIDERS } from './providers.mjs';
import { timestamp } from './timestamp.mjs';
export { TRANSCRIPT_PROVIDERS } from './providers.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const messageLabel = (role) => ['user', 'assistant', 'system', 'developer'].includes(role) ? `${role[0].toUpperCase()}${role.slice(1)} message` : 'Message';
const completedTypes = new Set(['Reasoning', 'AgentMessage', 'CommandExecution', 'McpToolCall', 'SubAgentActivity', 'FileChange', 'ImageView', 'ContextCompaction', 'Extension']);

function supported(row, provider) {
  if (provider === 'claude') return row.type === 'api-request'
    ? typeof row.id === 'string' && Boolean(row.id.trim())
    : ['assistant', 'user'].includes(row.type) && object(row.message);
  if (row.type === 'session_meta') return object(row.payload);
  if (!object(row.payload)) return false;
  if (row.type === 'response_item') return ['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(row.payload.type);
  return row.type === 'event_msg' && (['task_started', 'task_complete', 'turn_started', 'turn_complete', 'turn_aborted', 'token_count', 'error'].includes(row.payload.type) ||
    (row.payload.type === 'item_completed' && object(row.payload.item) && completedTypes.has(row.payload.item.type)));
}

function millisecondTimestamp(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 253402300799999) return null;
  return timestamp(new Date(value).toISOString());
}

function claudeTurnStatus(rows) {
  let status = 'unknown';
  // Content blocks can be split into several rows, and their timestamps can regress.
  // Fold lifecycle evidence in append order; span timing is sorted independently.
  for (const { row } of rows) {
    if (row.isMeta === true || row.isVisibleInTranscriptOnly === true || row.isCompactSummary === true) continue;
    if (row.isApiErrorMessage === true) { status = 'unknown'; continue; }
    if (row.type === 'api-request') { status = 'working'; continue; }
    if (row.type === 'user') {
      // Input may be a queued prompt, task notification, or tool result. It cannot
      // prove execution, but must not leave a previous terminal state current.
      if (status === 'idle') status = 'unknown';
      continue;
    }
    const reason = row.message.stop_reason;
    if (reason === 'tool_use') status = 'working';
    else if (reason === 'end_turn') status = 'idle';
    else if (reason !== undefined && reason !== null) status = 'unknown';
  }
  return status;
}

/** Parse one explicitly selected transcript. Input and returned detail are untrusted text. */
export function parseTranscript(text, { provider, sourceId, project } = {}) {
  if (typeof text !== 'string') throw new TypeError('Transcript must be a string.');
  if (!TRANSCRIPT_PROVIDERS.includes(provider)) throw new TypeError(`Provider must be one of ${TRANSCRIPT_PROVIDERS.join(', ')}.`);
  if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 4096) throw new TypeError('A stable sourceId is required (at most 4096 characters).');
  if (project !== undefined && (typeof project !== 'string' || !project.trim() || project.length > 200)) throw new TypeError('Project must be a nonempty string of at most 200 characters.');
  if (!['claude', 'codex'].includes(provider)) return parseAdditionalTranscript(text, { provider, sourceId, project },
    { timestamp, milliseconds: value => value === 0 ? '1970-01-01T00:00:00.000Z' : millisecondTimestamp(value) });

  const warnings = [];
  let omittedWarnings = 0;
  const warn = (message) => warnings.length < 100 ? warnings.push(message) : omittedWarnings++;
  let rows = [];
  let ordinal = 0;
  let firstMalformedOrdinal = null;
  let firstMetadata;
  const seen = new Set();
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch {
      firstMalformedOrdinal ??= ordinal;
      warn(`Line ${index + 1}: ${index === lines.length - 1 ? 'incomplete or malformed final JSON record' : 'invalid JSON record'} skipped.`);
      continue;
    }
    const recordOrdinal = ordinal++;
    if (!object(row)) { warn(`Line ${index + 1}: expected a JSON object; skipped.`); continue; }
    if ((provider === 'claude' && ((['assistant', 'user'].includes(row.type) && !object(row.message)) ||
        (row.type === 'api-request' && (typeof row.id !== 'string' || !row.id.trim())))) ||
        (provider === 'codex' && ['session_meta', 'response_item', 'event_msg'].includes(row.type) && !object(row.payload))) {
      warn(`Line ${index + 1}: malformed transcript record; skipped.`);
      continue;
    }
    if (provider === 'codex' && row.type === 'session_meta' && !firstMetadata) firstMetadata = { row, index, ordinal: recordOrdinal };
    if (!supported(row, provider)) continue;
    const at = timestamp(row.timestamp ?? (row.type === 'session_meta' ? row.payload.timestamp : undefined));
    if (!at) { warn(`Line ${index + 1}: missing or invalid timestamp; skipped.`); continue; }
    const identity = digest(JSON.stringify(row));
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push({ row, at, index, ordinal: recordOrdinal, identity });
  }
  if (firstMetadata) {
    const metadata = firstMetadata.row.payload;
    const boundary = metadata.subagent_history_start_ordinal;
    const linked = [metadata.parent_thread_id, metadata.forked_from_id].some((id) => typeof id === 'string' && id);
    const validBoundary = linked && Number.isSafeInteger(boundary) && boundary > firstMetadata.ordinal &&
      (firstMalformedOrdinal === null || firstMalformedOrdinal >= boundary || firstMalformedOrdinal === ordinal);
    if (boundary !== undefined && !validBoundary) warn('Invalid or unverified subagent history boundary; inherited records were retained.');
    if (validBoundary) warn(boundary >= ordinal
      ? 'Subagent history boundary not yet reached; inherited records were excluded while waiting for own records.'
      : 'Inherited records before the explicit subagent history boundary were excluded.');
    rows = rows.filter((entry) => {
      if (entry.row.type === 'session_meta') return entry.index === firstMetadata.index;
      if (validBoundary && entry.ordinal < boundary) return false;
      const payload = entry.row.payload;
      if (payload?.type === 'item_completed' && typeof metadata.id === 'string' && typeof payload.thread_id === 'string' && payload.thread_id !== metadata.id) {
        warn(`Line ${entry.index + 1}: completed item belongs to another thread; skipped.`);
        return false;
      }
      return true;
    });
  }
  const claudeStatus = provider === 'claude' ? claudeTurnStatus(rows) : 'unknown';
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
  if (!rows.length) {
    if (omittedWarnings) warnings.push(`${omittedWarnings} additional parser warnings omitted.`);
    return { commands: [], warnings };
  }

  const agentId = `${provider}-${digest(sourceId)}`;
  let clipped = false;
  let escaped = false;
  const display = (value, limit) => {
    const raw = typeof value === 'string' ? value : '';
    const visible = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (visible !== raw) escaped = true;
    if (visible.length > limit) clipped = true;
    return visible.slice(0, limit);
  };
  const agent = {
    id: agentId, name: `${provider === 'claude' ? 'Claude' : 'Codex'} session`,
    project: display(project ?? 'Imported sessions', 200), provider: provider === 'claude' ? 'Claude' : 'Codex',
    status: claudeStatus, startedAt: rows[0].at, lastSeen: rows.at(-1).at, cwd: '',
    contextUsed: null, contextLimit: null,
  };
  const spans = new Map();
  const calls = new Map();
  const results = new Map();
  const completedItems = [];
  const inputRequests = new Map();
  const inputReplies = new Map();
  const turnEnds = [];
  const itemId = (id) => `${agentId}-${digest(`codex-item:${id}`)}`;
  const detail = (value, limit = 12000) => {
    const string = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return display(string, limit);
  };
  const json = value => {
    if (object(value)) return value;
    try { return JSON.parse(value); } catch { return null; }
  };
  const inputRequest = (entry, id, name, input) => {
    if (!['request_user_input', 'request_user_input_async'].includes(name) || typeof id !== 'string' || !id) return;
    const questions = json(input)?.questions;
    const knownQuestions = Array.isArray(questions) && questions.length > 0;
    const previous = inputRequests.get(id);
    if (previous) {
      if (!previous.knownQuestions && knownQuestions) { previous.questions = questions; previous.knownQuestions = true; }
      return;
    }
    inputRequests.set(id, { at: entry.at, name, questions: knownQuestions ? questions : [{}], knownQuestions });
  };
  const inputReply = (entry, text) => {
    const match = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/.exec(text);
    if (!match) return;
    const decoded = json(match[1]);
    for (const value of Array.isArray(decoded) ? decoded : [decoded]) {
      if (!object(value) || typeof value.questionItemId !== 'string' || typeof value.question !== 'string' || typeof value.answer !== 'string') continue;
      const reference = json(value.questionItemId);
      if (!Array.isArray(reference) || reference.length !== 3 || reference[0] !== 'request_user_input_async' ||
          typeof reference[1] !== 'string' || !Number.isSafeInteger(reference[2]) || reference[2] < 0) continue;
      const key = JSON.stringify(reference.slice(1));
      if (!inputReplies.has(key)) inputReplies.set(key, []);
      inputReplies.get(key).push(entry.at);
    }
  };
  const instant = (entry, key, kind, label, value, startedAt = entry.at) => {
    const recordId = (typeof entry.row.uuid === 'string' && entry.row.uuid) ||
      (entry.row.type === 'api-request' && entry.row.id) || (typeof entry.row.payload?.id === 'string' && entry.row.payload.id) || entry.identity;
    const explicitId = entry.row.payload?.id;
    const id = provider === 'codex'
      ? (typeof explicitId === 'string' && explicitId ? itemId(explicitId) : `${agentId}-${digest(`codex-record:${entry.identity}:${key}`)}`)
      : `${agentId}-${digest(`${recordId}:${key}`)}`;
    spans.set(id, { id, agentId, laneId: 'main', kind, label, startedAt, endedAt: entry.at, detail: detail(value) });
  };
  const call = (entry, id, name, input, namespace, kind = 'tool') => {
    if (typeof id !== 'string' || !id) { warn(`Line ${entry.index + 1}: tool call has no call ID; skipped.`); return; }
    if (calls.has(id)) {
      const prior = calls.get(id);
      if (prior.startedAt !== entry.at || prior.detail !== detail(input)) warn(`Line ${entry.index + 1}: repeated tool call ID; retained its first invocation.`);
      return;
    }
    if (provider === 'codex' && typeof name === 'string' && (!namespace || namespace === 'functions')) inputRequest(entry, id, name.replace(/^functions\./, ''), input);
    calls.set(id, {
      id: provider === 'codex' ? itemId(id) : `${agentId}-${digest(`tool:${id}`)}`, agentId, laneId: 'main', kind,
      label: display([namespace, name].filter((part) => typeof part === 'string' && part).join('.'), 200) || 'Tool call', startedAt: entry.at, endedAt: null, detail: detail(input),
    });
  };
  const result = (entry, id, output, isError) => {
    if (typeof id !== 'string' || !id) { warn(`Line ${entry.index + 1}: tool result has no call ID; skipped.`); return; }
    if (!results.has(id)) results.set(id, []);
    results.get(id).push({ at: entry.at, output: detail(output), isError, line: entry.index + 1 });
  };
  const metadata = (value) => {
    if (typeof value.cwd === 'string' && value.cwd) {
      agent.cwd = display(value.cwd, 2048);
      if (project === undefined) agent.project = display(value.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1), 200) || 'Imported sessions';
    }
    const sessionId = provider === 'claude' ? value.sessionId : value.id;
    if (typeof sessionId === 'string' && sessionId) agent.name = `${agent.provider} ${display(sessionId, 80)}`;
    const startedAt = provider === 'codex' ? timestamp(value.timestamp) : null;
    if (startedAt && startedAt < agent.startedAt) agent.startedAt = startedAt;
  };
  if (firstMetadata) {
    metadata(firstMetadata.row.payload);
    agent.startedAt = timestamp(firstMetadata.row.payload.timestamp) ?? timestamp(firstMetadata.row.timestamp) ?? agent.startedAt;
    if (agent.lastSeen < agent.startedAt) agent.lastSeen = agent.startedAt;
  }

  for (const entry of rows) {
    const { row, at } = entry;
    if (provider === 'claude') {
      metadata(row);
      if (row.type === 'api-request') {
        instant(entry, 'api-request', 'message', 'Response requested', '');
        continue;
      }
      const usage = row.message.usage;
      if (object(usage) && count(usage.input_tokens)) {
        const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
        if (fields.every((key) => usage[key] === undefined || count(usage[key]))) {
          const used = fields.reduce((sum, key) => sum + (usage[key] ?? 0), 0);
          if (count(used)) agent.contextUsed = used;
        }
      }
      const content = row.message.content;
      if (typeof content === 'string') instant(entry, 'text', 'message', row.type === 'user' ? 'User message' : 'Assistant message', content);
      if (!Array.isArray(content)) continue;
      let thinkingStart = at;
      if (row.type === 'assistant' && row.thinkingDurationMs !== undefined) {
        const thinkingCount = content.filter(block => object(block) && block.type === 'thinking').length;
        const startMs = count(row.thinkingDurationMs) ? Date.parse(at) - row.thinkingDurationMs : NaN;
        // Only one block can receive a row-level duration. Keep dates in the
        // canonical four-digit-year range accepted by transcript timestamps.
        if (count(row.thinkingDurationMs) && thinkingCount === 1 &&
            startMs >= -62167219200000 && startMs <= 253402300799999) {
          thinkingStart = timestamp(new Date(startMs).toISOString()) ?? at;
        } else {
          warn(`Line ${entry.index + 1}: invalid or ambiguous thinking duration; retained instantaneous thinking records.`);
        }
      }
      content.forEach((block, index) => {
        if (!object(block)) return;
        if (block.type === 'text' && typeof block.text === 'string') instant(entry, `text:${index}`, 'message', row.type === 'user' ? 'User message' : 'Assistant message', block.text);
        if (block.type === 'thinking' && typeof block.thinking === 'string') instant(entry, `thinking:${index}`, 'thinking', 'Thinking record', block.thinking, thinkingStart);
        if (block.type === 'tool_use') call(entry, block.id, block.name, block.input);
        if (block.type === 'server_tool_use') call(entry, block.id, block.name, block.input, undefined, block.name === 'advisor' ? 'subagent' : 'tool');
        if (['tool_result', 'advisor_tool_result'].includes(block.type)) result(entry, block.tool_use_id, block.content, block.is_error === true);
      });
      continue;
    }

    const payload = row.payload;
    if (row.type === 'session_meta') continue;
    if (row.type === 'response_item') {
      if (['function_call', 'custom_tool_call'].includes(payload.type)) call(entry, payload.call_id, payload.name, payload.arguments ?? payload.input, payload.namespace);
      if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) result(entry, payload.call_id, payload.output, false);
      if (payload.type === 'message' && Array.isArray(payload.content)) {
        if (payload.role === 'user') for (const item of payload.content) {
          if (object(item) && item.type === 'input_text' && typeof item.text === 'string') inputReply(entry, item.text);
        }
        const text = payload.content.filter((item) => object(item) && ['input_text', 'output_text'].includes(item.type) && typeof item.text === 'string').map((item) => item.text).join('\n');
        if (text) instant(entry, 'message', 'message', messageLabel(payload.role), text);
      }
      if (payload.type === 'reasoning' && Array.isArray(payload.summary)) {
        const summary = payload.summary.filter((item) => object(item) && typeof item.text === 'string').map((item) => item.text).join('\n');
        if (summary) instant(entry, 'reasoning', 'thinking', 'Reasoning summary', summary);
      }
      continue;
    }
    if (payload.type === 'item_completed') { completedItems.push(entry); continue; }
    if (['task_started', 'turn_started'].includes(payload.type)) {
      agent.status = 'working';
      if (count(payload.model_context_window) && payload.model_context_window > 0) agent.contextLimit = payload.model_context_window;
      instant(entry, 'turn-started', 'message', 'Turn started', payload.turn_id ?? '');
    }
    if (['task_complete', 'turn_complete', 'turn_aborted'].includes(payload.type)) {
      turnEnds.push(at);
      agent.status = 'idle';
      const failed = object(payload.error) || payload.type === 'turn_aborted';
      instant(entry, 'turn-ended', failed ? 'error' : 'message', failed ? 'Turn ended with an error or interruption' : 'Turn completed', payload.error ?? payload.reason ?? payload.turn_id ?? '');
    }
    if (payload.type === 'error') instant(entry, 'error', 'error', 'Recorded error', payload.message ?? '');
    if (payload.type === 'token_count' && object(payload.info)) {
      const usage = payload.info.last_token_usage;
      // Context is the latest reported input, not cumulative session usage or cached input counted twice.
      if (object(usage) && count(usage.input_tokens)) agent.contextUsed = usage.input_tokens;
      if (count(payload.info.model_context_window) && payload.info.model_context_window > 0) agent.contextLimit = payload.info.model_context_window;
    }
  }

  for (const [id, span] of calls) {
    const matches = results.get(id) ?? [];
    const match = matches.find((item) => item.at >= span.startedAt);
    if (match) {
      span.endedAt = match.at;
      span.kind = match.isError ? 'error' : span.kind;
      span.detail = `Input:\n${detail(span.detail, 5900)}\n\nResult${match.isError ? ' (error)' : ''}:\n${detail(match.output, 5900)}`;
    } else if (matches.length) warn(`Line ${matches[0].line}: result predates its tool call; duration left open.`);
    spans.set(span.id, span);
  }
  // Completed items can precede their response records; merge only after all fallback records are paired.
  for (const entry of completedItems) {
    const { item, started_at_ms, completed_at_ms } = entry.row.payload;
    if (typeof item.id !== 'string' || !item.id) { warn(`Line ${entry.index + 1}: completed item has no ID; skipped.`); continue; }
    const id = itemId(item.id);
    const previous = spans.get(id);
    let kind = 'tool';
    let label;
    let value;
    switch (item.type) {
      case 'Reasoning':
        kind = 'thinking'; label = 'Reasoning';
        value = Array.isArray(item.summary_text) ? item.summary_text.filter((part) => typeof part === 'string').join('\n') : '';
        break;
      case 'AgentMessage': {
        if (item.delivery === 'async' && Array.isArray(item.questions) && item.questions.length) {
          inputRequest(entry, item.id, 'request_user_input_async', { questions: item.questions });
        }
        kind = previous?.kind === 'tool' ? 'tool' : 'message';
        label = kind === 'tool' ? previous.label : 'Assistant message';
        const text = Array.isArray(item.content) ? item.content.filter((part) => object(part) && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
        value = kind === 'tool' ? previous.detail : (text || (Array.isArray(item.questions) && item.questions.length ? { questions: item.questions } : previous?.detail ?? ''));
        break;
      }
      case 'CommandExecution':
        label = 'Command execution';
        value = { command: item.command, cwd: item.cwd, output: item.aggregated_output, exit_code: item.exit_code, status: item.status };
        break;
      case 'McpToolCall':
        label = [item.server, item.tool].filter((part) => typeof part === 'string' && part).join('.') || 'MCP tool';
        value = { arguments: item.arguments, result: item.result, error: item.error, status: item.status };
        break;
      case 'SubAgentActivity':
        kind = 'subagent'; label = `Subagent${typeof item.kind === 'string' ? `: ${item.kind}` : ' activity'}`;
        value = { kind: item.kind, agent_thread_id: item.agent_thread_id, agent_path: item.agent_path, model: item.model, reasoning_effort: item.reasoning_effort };
        break;
      case 'FileChange':
        label = 'File change'; value = { changes: item.changes, stdout: item.stdout, stderr: item.stderr, status: item.status };
        break;
      case 'ImageView':
        label = 'Image view'; value = item.path;
        break;
      case 'ContextCompaction':
        kind = 'message'; label = 'Context compaction'; value = '';
        break;
      case 'Extension':
        label = typeof item.kind === 'string' ? `Extension: ${item.kind}` : 'Extension';
        value = { query: item.query, action: item.action, results: item.results, status: item.status, error: item.error };
        break;
    }
    const failed = item.status === 'failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0) || item.isError === true || item.result?.isError === true || object(item.error) || (typeof item.error === 'string' && item.error.length > 0);
    const startedAt = millisecondTimestamp(started_at_ms);
    const endedAt = millisecondTimestamp(completed_at_ms);
    const validTiming = startedAt && endedAt && endedAt >= startedAt;
    if (!validTiming) warn(`Line ${entry.index + 1}: missing or invalid completed-item timing; kept matching transcript timing or an instant without inferring duration.`);
    spans.set(id, {
      id, agentId, laneId: 'main', kind: failed || previous?.kind === 'error' ? 'error' : kind, label: display(label, 200),
      startedAt: validTiming ? startedAt : previous?.startedAt ?? entry.at,
      endedAt: validTiming ? endedAt : previous ? previous.endedAt : entry.at,
      detail: detail(value),
    });
  }
  for (const [id, matches] of results) {
    if (!calls.has(id) && !(provider === 'codex' && spans.has(itemId(id)))) warn(`Line ${matches[0].line}: tool result has no matching invocation; no duration inferred.`);
  }
  for (const [id, request] of inputRequests) {
    const match = (results.get(id) ?? []).find(item => item.at >= request.at);
    let endedAt = null;
    let questions = request.questions;
    if (request.name === 'request_user_input_async') {
      // An accepted async tool result registers the question; it is not the user's answer.
      if (match && json(match.output)?.accepted !== true) endedAt = match.at;
      const replies = questions.map((_, index) => (inputReplies.get(JSON.stringify([id, index])) ?? []).find(at => at >= request.at));
      if (!endedAt && replies.every(Boolean)) endedAt = replies.reduce((latest, at) => at > latest ? at : latest);
      if (!endedAt) questions = questions.filter((_, index) => !replies[index]);
    } else {
      endedAt = [match?.at, turnEnds.find(at => at >= request.at)].filter(Boolean).sort()[0] ?? null;
      if (!endedAt) agent.status = 'waiting';
    }
    const attentionId = `${agentId}-${digest(`codex-input:${id}`)}`;
    const questionText = questions.filter(object).map(question => {
      const options = Array.isArray(question.options) ? question.options.map(option => typeof option === 'string' ? option
        : object(option) ? [option.label, option.description].filter(value => typeof value === 'string').join(': ') : '').filter(Boolean) : [];
      return [question.question ?? question.title, ...options.map(option => `- ${option}`)].filter(value => typeof value === 'string').join('\n');
    }).filter(Boolean).join('\n\n');
    spans.set(attentionId, { id: attentionId, agentId, laneId: 'main', kind: 'attention', label: 'User input requested',
      startedAt: request.at, endedAt, detail: detail(questionText || 'Reply in the source app.') });
  }
  let events = [...spans.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  let closures = [];
  if (events.length > 5000) {
    const pending = events.filter(event => event.kind === 'attention' && event.endedAt === null);
    if (pending.length > 5000) throw new RangeError('Too many unresolved input requests; at most 5000 can be retained.');
    const recent = events.filter(event => event.kind !== 'attention' || event.endedAt !== null);
    warn(`Retained 5000 of ${events.length} spans, including ${pending.length} unresolved input requests; earlier completed spans were omitted.`);
    events = [...pending, ...recent.slice(recent.length - Math.min(recent.length, 5000 - pending.length))]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const retained = new Set(events.map(event => event.id));
    // Replayed answers must close previously persisted requests even outside retained history.
    closures = recent.filter(event => event.kind === 'attention' && !retained.has(event.id));
  }
  if (clipped) warn('Some imported text was truncated to display limits (12000 characters per event, 5900 per paired input/output).');
  if (escaped) warn('Control characters are shown as visible Unicode escape notation; displayed text is not the raw transcript.');
  if (events.length) warn('Completed items and thinking records use explicit reported intervals when valid; other legacy spans use approximate transcript timestamps or instants.');
  if (omittedWarnings) warnings.push(`${omittedWarnings} additional parser warnings omitted.`);
  return { commands: [{ type: 'agent.upsert', data: agent }, ...[...closures, ...events].map((data) => ({ type: 'span.upsert', data }))], warnings };
}
