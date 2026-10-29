const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const contentText = content => (Array.isArray(content) ? content : [content])
  .map(part => typeof part === 'string' ? part : object(part) && typeof part.text === 'string' ? part.text : '')
  .filter(Boolean).join('\n');

/** Gemini CLI ConversationRecord JSON and append-only chat-recording JSONL. */
export function readGemini(text, { warn, timestamp, jsonRecords }) {
  const messages = new Map();
  const observedStarts = new Map();
  const metadata = {};
  const remember = message => {
    if (!object(message) || typeof message.id !== 'string' || !message.id) return;
    messages.set(message.id, message);
    for (const tool of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (!object(tool) || typeof tool.id !== 'string') continue;
      const at = timestamp(tool.timestamp);
      const key = `${message.id}:tool:${tool.id}`;
      if (at && (!observedStarts.has(key) || at < observedStarts.get(key))) observedStarts.set(key, at);
    }
  };
  const patchMessage = patch => {
    if (!object(patch) || typeof patch.id !== 'string') return;
    const existing = messages.get(patch.id);
    if (!existing) return;
    if (Object.hasOwn(patch, 'content')) existing.content = patch.content;
    for (const patchTool of Array.isArray(patch.toolCalls) ? patch.toolCalls : []) {
      if (!object(patchTool)) continue;
      const tool = (Array.isArray(existing.toolCalls) ? existing.toolCalls : []).find(item => object(item) && item.id === patchTool.id);
      if (tool && Object.hasOwn(patchTool, 'result')) tool.result = patchTool.result;
    }
  };
  for (const record of jsonRecords(text, warn)) {
    if (!object(record)) { warn('Non-object Gemini record skipped.'); continue; }
    if (typeof record.sessionId === 'string') {
      if (metadata.sessionId && record.sessionId !== metadata.sessionId) {
        warn('Multiple Gemini sessions in one file are unsupported; import separate files.'); return { events: [] };
      }
      for (const key of ['sessionId', 'startTime', 'lastUpdated', 'directories']) if (Object.hasOwn(record, key)) metadata[key] = record[key];
      if (Array.isArray(record.messages)) record.messages.forEach(remember);
    } else if (object(record.$set)) {
      for (const key of ['startTime', 'lastUpdated', 'directories']) if (Object.hasOwn(record.$set, key)) metadata[key] = record.$set[key];
      if (Array.isArray(record.$set.messages)) { messages.clear(); record.$set.messages.forEach(remember); }
    } else if (typeof record.$rewindTo === 'string') {
      const ids = [...messages.keys()];
      const index = ids.indexOf(record.$rewindTo);
      for (const id of index < 0 ? ids : ids.slice(index)) messages.delete(id);
      warn('Gemini rewind applied to this parse; previously persisted observations are retained.');
    } else if (object(record.$patch)) {
      patchMessage(record.$patch);
      if (Array.isArray(record.$patch.updates)) record.$patch.updates.forEach(patchMessage);
      if (Array.isArray(record.$patch.removeIds)) for (const id of record.$patch.removeIds) messages.delete(id);
      if (Array.isArray(record.$patch.orderIds)) {
        const ordered = record.$patch.orderIds.filter(id => typeof id === 'string' && messages.has(id));
        const selected = new Set(ordered);
        const entries = [...messages].filter(([id]) => !selected.has(id)).concat(ordered.map(id => [id, messages.get(id)]));
        messages.clear(); for (const [id, message] of entries) messages.set(id, message);
      }
    } else if (typeof record.id === 'string') remember(record);
  }
  const events = [];
  for (const message of messages.values()) {
    if (!['user', 'gemini', 'info', 'error', 'warning'].includes(message.type)) continue;
    const at = timestamp(message.timestamp);
    if (!at) { warn('Gemini message without a valid timestamp skipped.'); continue; }
    const content = contentText(message.content);
    if (content) events.push({ id: `${message.id}:message`, kind: message.type === 'error' ? 'error' : 'message',
      label: message.type === 'gemini' ? 'Assistant message' : `${message.type[0].toUpperCase()}${message.type.slice(1)} message`,
      startedAt: at, endedAt: at, detail: content });
    for (const [index, thought] of (Array.isArray(message.thoughts) ? message.thoughts : []).entries()) {
      if (!object(thought)) continue;
      const thoughtAt = timestamp(thought.timestamp);
      if (!thoughtAt) { warn('Gemini thought without a valid timestamp skipped.'); continue; }
      events.push({ id: `${message.id}:thought:${index}`, kind: 'thinking', label: 'Thought summary',
        startedAt: thoughtAt, endedAt: thoughtAt, detail: [thought.subject, thought.description].filter(value => typeof value === 'string').join('\n') });
    }
    for (const tool of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (!object(tool) || typeof tool.id !== 'string' || !tool.id) { warn('Gemini tool without a stable ID skipped.'); continue; }
      const id = `${message.id}:tool:${tool.id}`;
      const toolAt = timestamp(tool.timestamp);
      if (!toolAt) { warn('Gemini tool without a valid timestamp skipped.'); continue; }
      const done = ['success', 'error', 'cancelled'].includes(tool.status);
      events.push({ id, kind: tool.status === 'error' ? 'error' : 'tool', label: tool.name || 'Tool call',
        startedAt: observedStarts.get(id) ?? toolAt, endedAt: done ? toolAt : null,
        detail: { arguments: tool.args, result: tool.result, status: tool.status, agentId: tool.agentId } });
    }
  }
  if (events.length) warn('Gemini timings are recording observations; snapshots with one tool timestamp cannot establish execution duration.');
  return { sessionId: metadata.sessionId, cwd: Array.isArray(metadata.directories) ? metadata.directories.find(value => typeof value === 'string') : '',
    startedAt: timestamp(metadata.startTime), lastSeen: timestamp(metadata.lastUpdated), events };
}
