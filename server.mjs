import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, realpath, lstat, link } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommands } from './lib/model.mjs';
import { normalizeDomain, normalizeSource, sourceKey, sourcePrefix, namespaceId, createStore, validateStore, scopeCommands, purgeSource as removeSource, migrateLegacy } from './lib/domain.mjs';

const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const actions = new Set(['handoff.offer', 'handoff.claim', 'handoff.release', 'handoff.complete', 'attention.resolve']);
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenScope = (domain, role, source = '') => digest(JSON.stringify(normalizeDomain(domain)) + (role === 'ingest' ? `\n${source}` : '')).slice(0, 16);

export function mintToken(domain, role, source = '') {
  if (!['read', 'action', 'ingest'].includes(role)) throw fail('Unsupported access capability');
  return `rw1.${tokenScope(domain, role, source)}.${role}.${randomBytes(24).toString('hex')}`;
}

/** One lock per canonical state path. Stale locks require deliberate operator recovery. */
export async function acquireStateLock(path) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const target = join(await realpath(dirname(resolve(path))), basename(path));
  try { if (!(await lstat(target)).isFile()) throw fail('State must be a regular file, not a symlink or directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lockPath = `${target}.lock`;
  let file;
  try { file = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('State is locked by another instance or an interrupted run; verify it is stopped before removing its .lock file'); throw error; }
  try { await file.writeFile(JSON.stringify({ pid: process.pid })); await file.sync(); }
  catch (error) { await file.close(); await unlink(lockPath); throw error; }
  const owned = await file.stat({ bigint: true });
  let closed = false;
  const release = async () => {
    if (closed) return;
    closed = true;
    await file.close();
    try {
      const current = await lstat(lockPath, { bigint: true });
      if (current.dev === owned.dev && current.ino === owned.ino) await unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  release.path = target;
  return release;
}

export async function saveState(path, store, { exclusive = false } = {}) {
  const content = `${JSON.stringify(validateStore(store))}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw fail('Domain state exceeds 8 MiB; purge an enrolled source before importing more history', 413);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = null;
    // Linking publishes a fresh migration target without replacing an existing file.
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function loadState(path, domain, sources) {
  try {
    const content = await readFile(path);
    if (content.length > MAX_STATE_BYTES) throw fail('Saved domain state exceeds 8 MiB');
    return validateStore(JSON.parse(content.toString('utf8')), domain, sources);
  } catch (error) {
    if (error.code === 'ENOENT' && domain) return createStore(domain, sources ?? []);
    throw new Error(`Cannot load state; original file preserved: ${error.message}`);
  }
}

async function readJSON(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw fail('Use application/json', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 1_048_576) { request.resume(); throw fail('Request exceeds 1 MiB', 413); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('Invalid JSON'); }
}

export async function createServer({ domain = { id: 'local', environmentId: 'local' }, sources = [], state, dataFile = null, tokens = {}, mode = 'live', sessionTTL = 8 * 60 * 60 * 1000 } = {}) {
  domain = normalizeDomain(domain);
  sources = (sources.length ? sources : [{ id: 'api', provider: 'custom', toolInstanceId: 'event-api', generation: 1 }]).map(normalizeSource);
  if (!Number.isSafeInteger(sessionTTL) || sessionTTL < 1 || sessionTTL > 8 * 60 * 60 * 1000) throw fail('Invalid session lifetime');
  let releaseLock;
  let current;
  const clients = new Set();
  const grants = new Map();
  let queue = Promise.resolve();
  let accepting = true;
  const instanceId = randomBytes(12).toString('hex');
  const activeSources = new Map(sources.map(source => [sourceKey(source), source]));
  const issued = { read: '', action: '', ingest: {} };
  const addRoot = (role, provided, source = '') => {
    const token = provided ?? mintToken(domain, role, source);
    const prefix = `rw1.${tokenScope(domain, role, source)}.${role}.`;
    if (typeof token !== 'string' || !token.startsWith(prefix) || !/^[0-9a-f]{48}$/.test(token.slice(prefix.length))) throw fail(`Use a ${role} token issued for this domain/environment${source ? ' and source' : ''}; omit the token setting to generate one`);
    const key = digest(token);
    if (grants.has(key)) throw fail('Access tokens must be unique');
    grants.set(key, { key, role, source, root: true, expiresAt: Infinity });
    return token;
  };
  try {
    if (state && mode !== 'demo') throw fail('Initial unscoped state is only allowed for a synthetic demo; use explicit legacy migration for saved history');
    if (dataFile) { releaseLock = await acquireStateLock(dataFile); dataFile = releaseLock.path; }
    current = state
      ? migrateLegacy(state, { domain, source: sources[0], agentIds: state.agents.map(agent => agent.id) })
      : dataFile ? await loadState(dataFile, domain, sources) : createStore(domain, sources);
    issued.read = addRoot('read', tokens.read);
    issued.action = addRoot('action', tokens.action);
    for (const [key] of activeSources) {
      if (!current.revokedSources.includes(key)) issued.ingest[key] = addRoot('ingest', tokens.ingest?.[key], key);
    }
    if (tokens.ingest && Object.keys(tokens.ingest).some(key => !activeSources.has(key))) throw fail('Ingest token references an unenrolled source');
    if (dataFile) await saveState(dataFile, current);
  } catch (error) { await releaseLock?.(); throw error; }

  const valid = grant => grant && grants.get(grant.key) === grant && grant.expiresAt > Date.now() && (!grant.parent || grants.has(grant.parent));
  const revokeKey = key => {
    const grant = grants.get(key);
    clearTimeout(grant?.timer);
    grants.delete(key);
    for (const [childKey, child] of grants) if (child.parent === key) revokeKey(childKey);
    for (const client of clients) if (client.key === key) { client.response.end(); clients.delete(client); }
  };
  const authorize = (request, capability) => {
    const header = request.headers.authorization ?? '';
    const grant = header.startsWith('Bearer ') && header.length < 512 ? grants.get(digest(header.slice(7))) : null;
    if (!valid(grant)) throw fail('A valid access token is required', 401);
    if ((capability === 'read' && grant.role === 'ingest') || (capability === 'action' && grant.role !== 'action') || (capability === 'ingest' && grant.role !== 'ingest')) throw fail('This access capability does not allow the operation', 403);
    return grant;
  };
  const snapshot = () => {
    const byPrefix = new Map(current.sources.map(source => [sourcePrefix(domain, source), source]));
    const provenance = Object.fromEntries(current.state.agents.map(agent => {
      const source = byPrefix.get(agent.id.slice(0, 36));
      return [agent.id, { sourceId: source.id, toolInstanceId: source.toolInstanceId, generation: source.generation, identity: source.identity }];
    }));
    return structuredClone({ ...current.state, domain: { ...domain }, sources: current.sources.map(({ path, fileIdentity, ...source }) => ({ ...source, revoked: current.revokedSources.includes(sourceKey(source)) })), provenance, mode, instanceId, serverTime: new Date().toISOString() });
  };
  const access = grant => ({ readable: true, writable: grant.role === 'action', domain: { ...domain }, instanceId });
  const broadcast = () => {
    const message = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of clients) {
      if (!valid(grants.get(client.key))) { client.response.end(); clients.delete(client); }
      else if (client.response.writableLength > 2_097_152) { client.response.destroy(); clients.delete(client); }
      else client.response.write(message);
    }
  };
  const commit = operation => {
    if (!accepting) return Promise.reject(fail('The service is closing or closed', 503));
    const result = queue.then(async () => {
      const next = validateStore(await operation(current), domain);
      if (Buffer.byteLength(JSON.stringify(next)) + 1 > MAX_STATE_BYTES) throw fail('Domain state exceeds 8 MiB; purge an enrolled source before importing more history', 413);
      if (dataFile) await saveState(dataFile, next);
      current = next;
      broadcast();
      return { ok: true, revision: current.state.revision };
    });
    queue = result.catch(() => {});
    return result;
  };
  const dispatchSource = (key, commands, grant) => commit(store => {
    if (grant && !valid(grant)) throw fail('Access has expired or been revoked', 401);
    const source = activeSources.get(key);
    if (!source || store.revokedSources.includes(key)) throw Object.assign(fail('Source enrollment is inactive; use a new generation to enroll it again', 403), { code: 'SOURCE_REVOKED' });
    return { ...store, state: applyCommands(store.state, scopeCommands(domain, source, commands)) };
  });
  const purge = (id, grant) => commit(store => {
    if (grant && !valid(grant)) throw fail('Access has expired or been revoked', 401);
    return removeSource(store, id);
  }).then(result => {
    for (const [key, grantItem] of grants) if (grantItem.role === 'ingest' && activeSources.get(grantItem.source)?.id === id) revokeKey(key);
    return result;
  });
  const act = (command, grant) => commit(store => {
    if (!valid(grant)) throw fail('Access has expired or been revoked', 401);
    if (!command || Array.isArray(command) || !actions.has(command.type)) throw fail('Unsupported dashboard action');
    if (command.type === 'handoff.offer') {
      const agent = store.state.agents.find(item => item.id === command.data?.agentId);
      if (!agent) throw fail('Unknown agent');
      const source = store.sources.find(item => agent.id.startsWith(sourcePrefix(domain, item)));
      command = { ...command, data: { ...command.data, id: namespaceId(domain, source, command.data.id) } };
    }
    return { ...store, state: applyCommands(store.state, command) };
  });

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host)) throw fail('Unrecognized Host', 403);
      if (request.headers.origin && !hosts.map(host => `http://${host}`).includes(request.headers.origin)) throw fail('Cross-origin requests are not allowed', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw fail('Cross-site requests are not allowed', 403);
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true });
      if (url.pathname === '/api/session') {
        const grant = authorize(request, 'read');
        if (request.method === 'GET') return json(200, access(grant));
        if (request.method === 'DELETE') { revokeKey(grant.key); return json(200, { ok: true }); }
        if (request.method === 'POST') {
          if (!grant.root) throw fail('Use the issued root capability to create a new session', 403);
          for (const [key, value] of grants) if (!value.root && !valid(value)) revokeKey(key);
          if ([...grants.values()].filter(value => !value.root).length >= 64) throw fail('Too many browser sessions; lock an existing session first', 429);
          const sessionToken = `rws1.${randomBytes(32).toString('hex')}`;
          const key = digest(sessionToken);
          const session = { key, role: grant.role, source: '', parent: grant.key, expiresAt: Date.now() + sessionTTL };
          session.timer = setTimeout(() => revokeKey(key), sessionTTL);
          session.timer.unref();
          grants.set(key, session);
          return json(200, { ...access(session), sessionToken, expiresAt: session.expiresAt });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/state') { authorize(request, 'read'); return json(200, snapshot()); }
      if (request.method === 'GET' && url.pathname === '/api/stream') {
        const grant = authorize(request, 'read');
        if (clients.size >= 16) throw fail('Too many event streams', 429);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        const client = { response, key: grant.key };
        clients.add(client);
        response.on('close', () => clients.delete(client));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/events') {
        const grant = authorize(request, 'ingest');
        return json(200, await dispatchSource(grant.source, await readJSON(request), grant));
      }
      if (request.method === 'POST' && url.pathname === '/api/actions') {
        const grant = authorize(request, 'action');
        return json(200, await act(await readJSON(request), grant));
      }
      const sourceMatch = /^\/api\/sources\/([a-z0-9][a-z0-9-]{0,63})\/purge$/.exec(url.pathname);
      if (request.method === 'POST' && sourceMatch) return json(200, await purge(sourceMatch[1], authorize(request, 'action')));
      if (url.pathname.startsWith('/api/')) throw fail('Unknown endpoint or method', 404);
      if (!['GET', 'HEAD'].includes(request.method)) throw fail('Method not allowed', 405);
      const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!path.startsWith(publicRoot.endsWith(sep) ? publicRoot : `${publicRoot}${sep}`) || !mime[extname(path)]) throw fail('Not found', 404);
      let content;
      try { content = await readFile(path); } catch (error) { if (['ENOENT', 'EISDIR'].includes(error.code)) throw fail('Not found', 404); throw error; }
      response.writeHead(200, { 'Content-Type': mime[extname(path)] });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent) json(error.statusCode ?? 500, { error: error.statusCode ? error.message : 'Unable to complete request. Check the server and retry.' });
      else response.destroy();
    }
  });
  server.requestTimeout = 15_000;
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!valid(grants.get(client.key))) { client.response.end(); clients.delete(client); }
      else client.response.write(': keepalive\n\n');
    }
  }, 15_000);
  heartbeat.unref();
  let closing;
  return {
    server, tokens: issued, snapshot, dispatchSource, purgeSource: id => purge(id),
    revokeToken(token) { revokeKey(digest(token)); },
    listen(port = 4317) { return new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen(`http://127.0.0.1:${server.address().port}`); }); }); },
    close() {
      if (closing) return closing;
      accepting = false;
      closing = (async () => {
        clearInterval(heartbeat);
        for (const key of [...grants.keys()]) revokeKey(key);
        for (const client of clients) client.response.end();
        clients.clear();
        await queue;
        try { await new Promise((resolveClose, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolveClose())); }
        finally { await releaseLock?.(); }
      })();
      return closing;
    },
  };
}
