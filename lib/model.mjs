const LIMITS = { agents: 500, events: 5000, runs: 1000, handoffs: 1000, attention: 1000 };
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function object(value, keys, label, complete = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || forbiddenKeys.has(key) || !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) invalid(`Unexpected field in ${label}`);
  }
  if (complete && keys.some(key => !Object.hasOwn(value, key))) invalid(`Missing field in ${label}`);
}

function list(value, label, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) invalid(`Invalid ${label} collection`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`Invalid ${label} collection`);
  }
}

function text(value, label, max = 240, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    invalid(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters`);
  }
  return value;
}

const id = (value, label) => text(value, label, 160, true);
const nullableId = (value, label) => value === null ? null : id(value, label);
const shortText = (value, label) => text(value, label);
const title = (value, label) => text(value, label, 500, true);
const detail = (value, label) => text(value, label, 20000);

function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) invalid(`${label} must be an ISO UTC timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid(`${label} must be a valid date`);
  const canonical = parsed.toISOString();
  const input = value.replace(/(?:\.(\d{1,3}))?Z$/u, (_, fraction = '') => `.${fraction.padEnd(3, '0')}Z`);
  if (canonical !== input) invalid(`${label} must be a valid date`);
  return canonical;
}

const nullableDate = (value, label) => value === null ? null : date(value, label);
const choice = values => (value, label) => values.includes(value) ? value : invalid(`${label} must be one of ${values.join(', ')}`);
function number(value, label, integer = false) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) invalid(`${label} must be null or a nonnegative ${integer ? 'integer' : 'number'}`);
  return value;
}
const count = (value, label) => number(value, label, true);

const schemas = {
  agents: { id, name: shortText, project: shortText, provider: (value, label) => text(value, label, 80, true), status: choice(['working', 'idle', 'waiting', 'offline', 'unknown']), lastSeen: date, startedAt: date, cwd: (value, label) => text(value, label, 2048), contextUsed: count, contextLimit: count },
  events: { id, agentId: id, laneId: id, label: shortText, kind: choice(['thinking', 'tool', 'subagent', 'error', 'message']), startedAt: date, endedAt: nullableDate, detail },
  runs: { id, agentId: id, project: shortText, model: shortText, status: choice(['running', 'passed', 'failed']), startedAt: date, endedAt: nullableDate, checksPassed: count, checksTotal: count, cost: number, failure: detail },
  handoffs: { id, agentId: id, title, detail, status: choice(['offered', 'claimed', 'completed']), owner: nullableId, createdAt: date, updatedAt: date },
  attention: { id, agentId: id, title, detail, createdAt: date, resolvedAt: nullableDate },
};

function record(collection, data, previous, now) {
  const schema = schemas[collection];
  object(data, Object.keys(schema), collection);
  if (!Object.hasOwn(data, 'id')) invalid('id is required');
  const defaults = {
    agents: { id: data.id, name: data.id, project: 'Unassigned', provider: 'Custom', status: 'unknown', lastSeen: now, startedAt: now, cwd: '', contextUsed: null, contextLimit: null },
    events: { id: data.id, agentId: '', laneId: 'main', label: '', kind: 'message', startedAt: now, endedAt: null, detail: '' },
    runs: { id: data.id, agentId: '', project: 'Unassigned', model: '', status: 'running', startedAt: now, endedAt: null, checksPassed: null, checksTotal: null, cost: null, failure: '' },
    handoffs: { id: data.id, agentId: '', title: '', detail: '', status: 'offered', owner: null, createdAt: now, updatedAt: now },
    attention: { id: data.id, agentId: '', title: '', detail: '', createdAt: now, resolvedAt: null },
  };
  const result = {};
  for (const [key, validate] of Object.entries(schema)) result[key] = validate(Object.hasOwn(data, key) ? data[key] : (previous ?? defaults[collection])[key], `${collection}.${key}`);
  if (collection === 'agents' && result.lastSeen < result.startedAt) invalid('lastSeen precedes startedAt');
  if (['events', 'runs'].includes(collection) && result.endedAt !== null && result.endedAt < result.startedAt) invalid('endedAt precedes startedAt');
  if (collection === 'runs') {
    if (result.checksPassed !== null && result.checksTotal !== null && result.checksPassed > result.checksTotal) invalid('checksPassed exceeds checksTotal');
    if ((result.status === 'running') !== (result.endedAt === null)) invalid('Running runs must be open; finished runs require endedAt');
  }
  if (collection === 'handoffs') {
    if (result.updatedAt < result.createdAt) invalid('updatedAt precedes createdAt');
    if ((result.status === 'offered') !== (result.owner === null)) invalid('Offered handoffs have no owner; claimed and completed handoffs require an owner');
  }
  if (collection === 'attention' && result.resolvedAt !== null && result.resolvedAt < result.createdAt) invalid('resolvedAt precedes createdAt');
  return result;
}

export function emptyState() {
  return { version: 1, revision: 0, agents: [], runs: [], handoffs: [], attention: [], events: [] };
}

export function validateSnapshot(raw) {
  object(raw, ['version', 'revision', ...Object.keys(LIMITS)], 'snapshot', true);
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0) invalid('Invalid snapshot version or revision');
  const state = emptyState();
  state.revision = raw.revision;
  for (const [collection, limit] of Object.entries(LIMITS)) {
    list(raw[collection], collection, limit);
    const seen = new Set();
    state[collection] = raw[collection].map(item => {
      object(item, Object.keys(schemas[collection]), collection, true);
      const clean = record(collection, item);
      if (seen.has(clean.id)) invalid(`Duplicate ${collection} id`);
      seen.add(clean.id);
      return clean;
    });
  }
  const agents = new Set(state.agents.map(agent => agent.id));
  for (const collection of ['events', 'runs', 'handoffs', 'attention']) {
    for (const item of state[collection]) if (!agents.has(item.agentId)) invalid(`Unknown agent: ${item.agentId}`);
  }
  return state;
}

function trim(state, collection) {
  if (state[collection].length <= LIMITS[collection]) return;
  if (collection === 'agents') invalid('Agent limit reached');
  if (collection === 'handoffs' || collection === 'attention') {
    const done = item => collection === 'handoffs' ? item.status === 'completed' : item.resolvedAt !== null;
    const removable = state[collection].filter(done).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const removeCount = state[collection].length - LIMITS[collection];
    if (removable.length < removeCount) invalid(`Too many unresolved ${collection}`);
    const removed = new Set(removable.slice(0, removeCount).map(item => item.id));
    state[collection] = state[collection].filter(item => !removed.has(item.id));
  } else {
    state[collection] = state[collection].slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-LIMITS[collection]);
  }
}

export function applyCommands(current, commands, now = new Date().toISOString()) {
  now = date(now, 'now');
  const state = validateSnapshot(current);
  if (state.revision === Number.MAX_SAFE_INTEGER) invalid('Revision limit reached');
  const batch = Array.isArray(commands) ? commands : [commands];
  list(batch, 'commands', 1000);
  if (batch.length === 0 || batch.length > 1000) invalid('A batch must contain 1 to 1000 commands');
  for (const command of batch) {
    object(command, ['type', 'data'], 'command', true);
    if (typeof command.type !== 'string') invalid('Command type must be text');
    const collections = { 'agent.upsert': 'agents', 'span.upsert': 'events', 'run.upsert': 'runs', 'handoff.offer': 'handoffs', 'attention.open': 'attention' };
    const collection = Object.hasOwn(collections, command.type) ? collections[command.type] : null;
    if (collection) {
      const data = command.data;
      object(data, Object.keys(schemas[collection]), collection);
      id(data.id, 'id');
      const index = state[collection].findIndex(item => item.id === data.id);
      if (index >= 0 && ['handoffs', 'attention'].includes(collection)) invalid(`${collection} id already exists`, 409);
      if (collection === 'handoffs' && (Object.hasOwn(data, 'status') || Object.hasOwn(data, 'owner') || Object.hasOwn(data, 'updatedAt'))) invalid('Offer only accepts id, agentId, title, detail and createdAt');
      if (collection === 'attention' && Object.hasOwn(data, 'resolvedAt')) invalid('New attention must be unresolved');
      const item = record(collection, data, state[collection][index], now);
      if (collection !== 'agents' && !state.agents.some(agent => agent.id === item.agentId)) invalid(`Unknown agent: ${item.agentId}`);
      if (index < 0) state[collection].push(item);
      else state[collection][index] = item;
      trim(state, collection);
      continue;
    }
    if (['handoff.claim', 'handoff.release', 'handoff.complete'].includes(command.type)) {
      object(command.data, ['id', 'owner'], 'handoff action', true);
      const handoffId = id(command.data.id, 'id');
      const owner = id(command.data.owner, 'owner');
      const handoff = state.handoffs.find(item => item.id === handoffId);
      if (!handoff) invalid('Unknown handoff');
      if (now < handoff.updatedAt) invalid('Action timestamp precedes the latest handoff update');
      if (command.type === 'handoff.claim') {
        if (handoff.status !== 'offered') invalid('Handoff is no longer offered', 409);
        handoff.status = 'claimed';
        handoff.owner = owner;
      } else {
        if (handoff.status !== 'claimed' || handoff.owner !== owner) invalid('Only the current owner can release or complete a claimed handoff', 409);
        handoff.status = command.type === 'handoff.release' ? 'offered' : 'completed';
        if (handoff.status === 'offered') handoff.owner = null;
      }
      handoff.updatedAt = now;
    } else if (command.type === 'attention.resolve') {
      object(command.data, ['id'], 'attention action', true);
      const attentionId = id(command.data.id, 'id');
      const attention = state.attention.find(item => item.id === attentionId);
      if (!attention) invalid('Unknown attention item');
      if (attention.resolvedAt !== null) invalid('Attention is already resolved', 409);
      if (now < attention.createdAt) invalid('Resolution precedes attention creation');
      attention.resolvedAt = now;
    } else invalid('Unknown command type');
  }
  state.revision += 1;
  return state;
}
