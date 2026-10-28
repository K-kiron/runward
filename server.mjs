import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommands, emptyState, validateSnapshot } from './lib/model.mjs';

const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const actions = new Set(['handoff.offer', 'handoff.claim', 'handoff.release', 'handoff.complete', 'attention.resolve']);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(state)}\n`);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function loadState(path) {
  try { return validateSnapshot(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyState();
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

export async function createServer({ state, dataFile = null, token = randomBytes(24).toString('hex'), mode = 'live' } = {}) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) throw fail('Token must contain 16–256 characters');
  let current = state ? validateSnapshot(state) : dataFile ? await loadState(dataFile) : emptyState();
  const instanceId = randomBytes(12).toString('hex');
  let queue = Promise.resolve();
  const clients = new Set();
  const snapshot = () => ({ ...current, mode, instanceId, serverTime: new Date().toISOString() });
  const authenticated = request => {
    if (!request.headers.authorization?.startsWith('Bearer ')) return false;
    const provided = Buffer.from(request.headers.authorization.slice(7));
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
  const broadcast = () => {
    const message = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 2_097_152) { client.destroy(); clients.delete(client); }
      else client.write(message);
    }
  };
  const dispatch = commands => {
    const result = queue.then(async () => {
      const next = applyCommands(current, commands);
      if (dataFile) await saveState(dataFile, next);
      current = next;
      broadcast();
      return { ok: true, revision: current.revision };
    });
    queue = result.catch(() => {});
    return result;
  };
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
      if (request.method === 'GET' && url.pathname === '/api/session') return json(200, { writable: authenticated(request) });
      if (request.method === 'GET' && url.pathname === '/api/state') return json(200, snapshot());
      if (request.method === 'GET' && url.pathname === '/api/stream') {
        if (clients.size >= 16) throw fail('Too many event streams', 429);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'POST' && ['/api/events', '/api/actions'].includes(url.pathname)) {
        if (!authenticated(request)) throw fail('A valid write token is required', 401);
        const commands = await readJSON(request);
        if (url.pathname === '/api/actions' && (!commands || Array.isArray(commands) || !actions.has(commands.type))) throw fail('Unsupported dashboard action');
        return json(200, await dispatch(commands));
      }
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
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keepalive\n\n'); }, 15_000);
  heartbeat.unref();
  return {
    server, token, dispatch, snapshot,
    listen(port = 4317) { return new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen(`http://127.0.0.1:${server.address().port}`); }); }); },
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      await queue;
      await new Promise((resolveClose, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolveClose()));
    }
  };
}
