import { createHash } from 'node:crypto';
import { emptyState, validateSnapshot } from './model.mjs';

const MAX_SOURCES = 1000;
const collections = ['agents', 'events', 'runs', 'handoffs', 'attention'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }

function object(value, keys, label, required = []) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`Invalid ${label}`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || forbidden.has(key) || !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) invalid(`Unexpected field in ${label}`);
  }
  if (required.some(key => !Object.hasOwn(value, key))) invalid(`Missing field in ${label}`);
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`Invalid ${label}`);
  return value;
}

function list(value, label, limit = MAX_SOURCES) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) invalid(`Invalid ${label} collection`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`Invalid ${label} collection`);
  }
}

function slug(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value) || forbidden.has(value)) invalid(`Invalid ${label}; use a lowercase slug of at most 64 characters`);
  return value;
}

export function normalizeDomain(value) {
  object(value, ['id', 'environmentId'], 'domain', ['id', 'environmentId']);
  return { id: slug(value.id, 'domain id'), environmentId: slug(value.environmentId, 'environment id') };
}

export function normalizeSource(value) {
  object(value, ['id', 'provider', 'toolInstanceId', 'generation', 'identity', 'path', 'fileIdentity'], 'source', ['id', 'provider', 'toolInstanceId', 'generation']);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) invalid('Source generation must be a positive safe integer');
  let identity = { alias: null, evidence: 'unknown' };
  if (typeof value.identity === 'string') identity = { alias: text(value.identity, 'identity alias', 128), evidence: 'operator-asserted' };
  else if (value.identity != null) {
    object(value.identity, ['alias', 'evidence'], 'source identity', ['alias', 'evidence']);
    if (value.identity.evidence === 'operator-asserted') identity = { alias: text(value.identity.alias, 'identity alias', 128), evidence: 'operator-asserted' };
    else if (value.identity.evidence !== 'unknown' || value.identity.alias !== null) invalid('Identity evidence must be operator-asserted or unknown');
  }
  let fileIdentity = null;
  if (value.fileIdentity != null) {
    object(value.fileIdentity, ['realpath', 'dev', 'ino'], 'file identity', ['realpath', 'dev', 'ino']);
    for (const key of ['dev', 'ino']) if (typeof value.fileIdentity[key] !== 'string' || !/^(?:0|[1-9][0-9]{0,29})$/u.test(value.fileIdentity[key])) invalid(`Invalid file ${key}`);
    fileIdentity = { realpath: text(value.fileIdentity.realpath, 'file realpath', 4096), dev: value.fileIdentity.dev, ino: value.fileIdentity.ino };
  }
  return {
    id: slug(value.id, 'source id'), provider: slug(value.provider, 'provider'), toolInstanceId: slug(value.toolInstanceId, 'tool instance id'),
    generation: value.generation, identity, path: value.path == null ? null : text(value.path, 'source path', 4096), fileIdentity,
  };
}

export function sourceKey(source) {
  const clean = normalizeSource(source);
  return `${clean.id}:${clean.generation}`;
}

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);

export function sourcePrefix(domain, source) {
  const owner = normalizeDomain(domain);
  const enrollment = normalizeSource(source);
  return `rw_${digest(JSON.stringify([owner.id, owner.environmentId, enrollment.id, enrollment.generation]))}_`;
}

export function namespaceId(domain, source, value) {
  return `${sourcePrefix(domain, source)}${digest(text(value, 'producer id', 160))}`;
}

const ingestFields = {
  'agent.upsert': ['id', 'name', 'project', 'provider', 'status', 'lastSeen', 'startedAt', 'cwd', 'contextUsed', 'contextLimit'],
  'span.upsert': ['id', 'agentId', 'laneId', 'label', 'kind', 'startedAt', 'endedAt', 'detail'],
  'run.upsert': ['id', 'agentId', 'project', 'model', 'status', 'startedAt', 'endedAt', 'checksPassed', 'checksTotal', 'cost', 'failure'],
  'handoff.offer': ['id', 'agentId', 'title', 'detail', 'createdAt'],
  'attention.open': ['id', 'agentId', 'title', 'detail', 'createdAt'],
};

/** Scope untrusted producer IDs; the state reducer validates field values and references. */
export function scopeCommands(domain, source, commands) {
  const owner = normalizeDomain(domain);
  const enrollment = normalizeSource(source);
  const batch = Array.isArray(commands) ? commands : [commands];
  list(batch, 'commands', 1000);
  if (!batch.length) invalid('A batch must contain at least one command');
  return batch.map(command => {
    object(command, ['type', 'data'], 'command', ['type', 'data']);
    if (typeof command.type !== 'string' || !Object.hasOwn(ingestFields, command.type)) invalid('Unsupported source ingestion command');
    const fields = ingestFields[command.type];
    object(command.data, fields, 'command data', ['id']);
    const data = {};
    for (const key of fields) if (Object.hasOwn(command.data, key)) {
      const value = command.data[key];
      if (['id', 'agentId'].includes(key)) data[key] = namespaceId(owner, enrollment, value);
      else {
        // laneId is display/grouping text local to the scoped agent, never an authorization reference.
        if (value !== null && !(typeof value === 'string' && value.length <= 20000) && !(typeof value === 'number' && Number.isFinite(value))) invalid(`Invalid command field ${key}`);
        data[key] = value;
      }
    }
    if (command.type === 'agent.upsert') data.provider = enrollment.provider;
    return { type: command.type, data };
  });
}

function normalizeSources(sources) {
  list(sources, 'sources');
  const seen = new Set();
  return sources.map(value => {
    const source = normalizeSource(value);
    const key = sourceKey(source);
    if (seen.has(key)) invalid('Duplicate source generation');
    seen.add(key);
    return source;
  });
}

export function createStore(domain, sources) {
  return { version: 2, domain: normalizeDomain(domain), sources: normalizeSources(sources), state: emptyState(), revokedSources: [] };
}

function cleanStore(raw, expectedDomain) {
  if (raw && typeof raw === 'object' && Object.getOwnPropertyDescriptor(raw, 'version')?.value === 1) invalid('Legacy state requires explicit migration');
  const fields = ['version', 'domain', 'sources', 'state', 'revokedSources'];
  object(raw, fields, 'domain store', fields);
  if (raw.version !== 2) invalid('Unsupported domain store version');
  const domain = normalizeDomain(raw.domain);
  if (expectedDomain !== undefined && JSON.stringify(domain) !== JSON.stringify(normalizeDomain(expectedDomain))) invalid('Domain or environment does not match the store');
  const sources = normalizeSources(raw.sources);
  const keys = new Set(sources.map(sourceKey));
  list(raw.revokedSources, 'revoked sources');
  const revoked = new Set();
  for (const key of raw.revokedSources) {
    if (typeof key !== 'string' || !keys.has(key) || revoked.has(key)) invalid('Invalid revoked source generation');
    revoked.add(key);
  }
  const byPrefix = new Map();
  for (const source of sources) {
    const prefix = sourcePrefix(domain, source);
    if (byPrefix.has(prefix)) invalid('Source namespace collision');
    byPrefix.set(prefix, source);
  }
  const state = validateSnapshot(raw.state);
  for (const collection of collections) for (const record of state[collection]) {
    if (!/^rw_[0-9a-f]{32}_[0-9a-f]{32}$/u.test(record.id)) invalid('Record is outside an enrolled source namespace');
    const prefix = record.id.slice(0, 36);
    const source = byPrefix.get(prefix);
    if (!source || revoked.has(sourceKey(source))) invalid('Record belongs to an unknown or revoked source');
    if (collection !== 'agents' && !record.agentId.startsWith(prefix)) invalid('Cross-source agent reference');
  }
  return { version: 2, domain, sources, state, revokedSources: [...revoked] };
}

function reconcile(clean, sources) {
  const configured = normalizeSources(sources);
  const stored = new Map(clean.sources.map(source => [sourceKey(source), source]));
  const revoked = new Set(clean.revokedSources);
  for (const source of configured) {
    const key = sourceKey(source);
    if (revoked.has(key)) invalid('Revoked source generation cannot be enrolled again');
    if (stored.has(key)) {
      if (JSON.stringify(stored.get(key)) !== JSON.stringify(source)) invalid('Source enrollment changed; use a new generation');
    } else {
      if (clean.sources.length >= MAX_SOURCES) invalid('Source enrollment limit reached');
      clean.sources.push(source);
      stored.set(key, source);
    }
  }
  return clean;
}

export function validateStore(raw, domain, sources) {
  const clean = cleanStore(raw, domain);
  return sources === undefined ? clean : reconcile(clean, sources);
}

export function reconcileSources(store, sources) {
  return reconcile(cleanStore(store), sources);
}

export function purgeSource(store, id) {
  id = slug(id, 'source id');
  const clean = cleanStore(store);
  const removed = clean.sources.filter(source => source.id === id);
  if (!removed.length) invalid('Unknown source id');
  if (clean.state.revision === Number.MAX_SAFE_INTEGER) invalid('Revision limit reached');
  const prefixes = new Set(removed.map(source => sourcePrefix(clean.domain, source)));
  clean.revokedSources = [...new Set([...clean.revokedSources, ...removed.map(sourceKey)])];
  for (const collection of collections) clean.state[collection] = clean.state[collection].filter(record => !prefixes.has(record.id.slice(0, 36)));
  clean.state.revision += 1;
  return clean;
}

/** Explicitly selected legacy records retain their content; the original snapshot is untouched. */
export function migrateLegacy(raw, options) {
  object(options, ['domain', 'source', 'agentIds'], 'migration options', ['domain', 'source', 'agentIds']);
  list(options.agentIds, 'selected agents', 500);
  if (!options.agentIds.length) invalid('Explicit nonempty agent selection is required');
  const selected = new Set();
  for (const value of options.agentIds) {
    const id = text(value, 'selected agent id', 160);
    if (selected.has(id)) invalid('Duplicate selected agent id');
    selected.add(id);
  }
  const legacy = validateSnapshot(raw);
  const known = new Set(legacy.agents.map(agent => agent.id));
  if ([...selected].some(id => !known.has(id))) invalid('Selected agent does not exist in legacy state');
  const store = createStore(options.domain, [options.source]);
  const source = store.sources[0];
  store.state.revision = legacy.revision;
  for (const collection of collections) {
    store.state[collection] = legacy[collection].filter(record => selected.has(collection === 'agents' ? record.id : record.agentId)).map(record => {
      const scoped = { ...record, id: namespaceId(store.domain, source, record.id) };
      if (collection !== 'agents') scoped.agentId = namespaceId(store.domain, source, record.agentId);
      return scoped;
    });
  }
  return validateStore(store);
}
