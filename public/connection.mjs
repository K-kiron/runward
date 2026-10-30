const MAX_EVENT_CHARS = 16 * 1024 * 1024;
const authenticationError = () => new Error('Access expired or was revoked. Connect again with a server token.');
const sameDomain = (a, b) => a?.id === b?.id && a?.environmentId === b?.environmentId;
const validDomain = (domain) => typeof domain?.id === 'string' && domain.id.length > 0 &&
  typeof domain.environmentId === 'string' && domain.environmentId.length > 0;

// Only fixed, same-origin API routes are exposed. Credentials never enter URLs or storage.
export function createConnection({
  fetch: transport = globalThis.fetch.bind(globalThis), onState = () => {}, onAccess = () => {},
  onStatus = () => {}, setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout, retryMs = 2000, maxEventChars = MAX_EVENT_CHARS,
} = {}) {
  let generation = 0;
  let session = null;
  let retry = null;
  let revision = -1;
  const pending = new Set();
  const readers = new Set();
  const current = (context) => context.generation === generation && session === context;
  const status = (phase, message = '') => onStatus({ phase, message });
  const access = (context) => ({ readable: true, writable: context.writable,
    domain: { ...context.domain }, instanceId: context.instanceId });
  const options = (token, extra = {}) => ({
    cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    ...extra, headers: { ...extra.headers, Authorization: `Bearer ${token}` },
  });

  function revoke(token) {
    // UI clearing must not wait for a failed or delayed logout request.
    void Promise.resolve().then(() => transport('/api/session', options(token, {
      method: 'DELETE', keepalive: true,
    }))).catch(() => {});
  }
  function clear(message = '') {
    const old = session;
    generation++;
    session = null;
    revision = -1;
    if (retry !== null) cancel(retry);
    retry = null;
    for (const controller of pending) controller.abort();
    pending.clear();
    for (const reader of readers) void reader.cancel().catch(() => {});
    readers.clear();
    onState(null);
    onAccess(null);
    status('locked', message);
    if (old) revoke(old.token);
  }
  function rejectAccess(context, message = authenticationError().message) {
    if (current(context)) clear(message);
  }
  async function response(context, path, extra = {}) {
    const controller = new AbortController();
    pending.add(controller);
    try {
      const result = await transport(path, options(context.token, { ...extra, signal: controller.signal }));
      if (!current(context)) return null;
      if (result.status === 401 || result.status === 403) {
        rejectAccess(context);
        return null;
      }
      if (!result.ok) throw Object.assign(new Error(`Request failed (${result.status}). Check the server and retry.`), { status: result.status });
      const body = await result.json();
      return current(context) ? body : null;
    } finally { pending.delete(controller); }
  }
  function accept(context, snapshot) {
    if (!current(context)) return false;
    // A different launch or domain is a different authority, even at the same URL.
    if (snapshot?.instanceId !== context.instanceId || !sameDomain(snapshot?.domain, context.domain)) {
      rejectAccess(context, 'The server instance or domain changed. Connect again to review the new authority.');
      return false;
    }
    if (!['agents', 'events', 'runs', 'handoffs', 'attention'].every(key => Array.isArray(snapshot[key])) ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error('The server returned an invalid activity snapshot. Check the server and retry.');
    }
    if (snapshot.revision < revision) return false;
    revision = snapshot.revision;
    onState(snapshot);
    return true;
  }
  async function refresh() {
    const context = session;
    if (!context) return false;
    try {
      const snapshot = await response(context, '/api/state');
      return snapshot !== null && accept(context, snapshot);
    } catch (error) {
      if (current(context)) status('reconnecting', error instanceof SyntaxError
        ? 'The server returned unreadable activity. Check the server and retry.' : error.message);
      return false;
    }
  }
  function reconnect(context, message) {
    if (!current(context)) return;
    status('reconnecting', message);
    retry = schedule(() => {
      retry = null;
      if (current(context)) void stream(context);
    }, retryMs);
  }
  async function stream(context) {
    const controller = new AbortController();
    pending.add(controller);
    let reader;
    try {
      const result = await transport('/api/stream', options(context.token, {
        headers: { Accept: 'text/event-stream' }, signal: controller.signal,
      }));
      if (!current(context)) { void result.body?.cancel().catch(() => {}); return; }
      if (result.status === 401 || result.status === 403) { rejectAccess(context); return; }
      if (!result.ok || !result.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !result.body) {
        throw new Error('Could not open the activity stream. Check the server connection.');
      }
      reader = result.body.getReader();
      readers.add(reader);
      const decoder = new TextDecoder();
      let buffer = '';
      let type = '';
      let data = [];
      let eventChars = 0;
      const limit = (length) => {
        if (length > maxEventChars) throw new Error('Activity exceeds the browser stream limit. Reduce retained history before reconnecting.');
      };
      const line = (value) => {
        eventChars += value.length;
        limit(eventChars);
        if (value === '') {
          if (type === 'state' && data.length) {
            let snapshot;
            try { snapshot = JSON.parse(data.join('\n')); }
            catch { throw new Error('The server sent an unreadable activity event. Check the server and retry.'); }
            accept(context, snapshot);
          }
          type = ''; data = []; eventChars = 0;
        } else if (value.startsWith('event:')) type = value.slice(6).trim();
        else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
      };
      status('live');
      while (current(context)) {
        const chunk = await reader.read();
        if (!current(context)) return;
        if (chunk.done) throw new Error('The activity stream closed. Reconnecting with the current session.');
        buffer += decoder.decode(chunk.value, { stream: true });
        // Accept LF and CRLF framing, including boundaries split across chunks.
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const value = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          line(value);
          if (!current(context)) return;
        }
        limit(buffer.length + eventChars);
      }
    } catch (error) {
      if (current(context)) reconnect(context, error.message);
    } finally {
      pending.delete(controller);
      controller.abort();
      if (reader) { readers.delete(reader); try { await reader.cancel(); } catch {} }
    }
  }
  async function login(rootToken) {
    clear();
    const attempt = generation;
    const controller = new AbortController();
    pending.add(controller);
    status('connecting');
    try {
      const result = await transport('/api/session', options(rootToken, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
      }));
      rootToken = '';
      if (!result.ok) throw new Error(result.status === 401 || result.status === 403
        ? 'The server token was not accepted. Check its access and try again.' : `Could not create a session (${result.status}).`);
      const body = await result.json();
      if (attempt !== generation) {
        if (typeof body?.sessionToken === 'string' && body.sessionToken) revoke(body.sessionToken);
        return null;
      }
      if (body?.readable !== true || typeof body.writable !== 'boolean' || !validDomain(body.domain) ||
          typeof body.instanceId !== 'string' || !body.instanceId || typeof body.sessionToken !== 'string' || !body.sessionToken) {
        if (typeof body?.sessionToken === 'string' && body.sessionToken) revoke(body.sessionToken);
        throw new Error('The server returned an invalid session. Check the server version.');
      }
      session = { ...access(body), token: body.sessionToken, generation };
      const publicAccess = access(session);
      onAccess(publicAccess);
      void refresh();
      void stream(session);
      return publicAccess;
    } catch (error) {
      if (attempt !== generation) return null;
      clear(error instanceof SyntaxError ? 'The server returned an unreadable session.' : error.message);
      throw new Error(error instanceof SyntaxError ? 'The server returned an unreadable session.' : error.message);
    } finally { rootToken = ''; pending.delete(controller); }
  }
  async function action(payload) {
    const context = session;
    if (!context) return false;
    if (!context.writable) throw new Error('This session is read-only. Connect with an action token to coordinate work.');
    try {
      const result = await response(context, '/api/actions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      return result !== null && current(context);
    } catch (error) {
      if (!current(context)) return false;
      throw error;
    }
  }
  return { login, logout: clear, refresh, action };
}
