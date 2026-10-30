import { createConnection } from './connection.mjs';

const $ = (selector) => document.querySelector(selector);
const kinds = ['thinking', 'tool', 'subagent', 'error', 'message'];
const state = {
  snapshot: null, access: null, owner: '', selectedAgent: null, selectedSpan: null,
  tab: 'waterfall', expanded: false, allRuns: false, completed: false,
  search: '', project: '', provider: '', status: '', window: 'all',
  connected: false, phase: 'locked', receivedAt: 0, clockOffset: 0, pending: false,
};
let loginAttempt = 0;
let previousScroll = 0;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const shortTimeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const numberFormat = new Intl.NumberFormat(undefined);
const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const ingestionCommand = 'node cli.mjs --domain personal --environment laptop --watch "codex=/path/to/session.jsonl"\nnode cli.mjs --config /path/to/domain.json\nnode cli.mjs ingest /path/to/events.json';

function node(tag, className, text, attributes = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}
function append(parent, ...children) { parent.append(...children.filter(Boolean)); return parent; }
function button(text, action, id, className = '') {
  return node('button', className, text, { type: 'button', 'data-action': action, 'data-id': id ?? '', 'data-focus': `${action}:${id ?? ''}` });
}
function empty(text) { return node('p', 'empty', text); }
function now() { return Date.now() + state.clockOffset; }
function timestamp(value) { const result = Date.parse(value); return Number.isFinite(result) ? result : null; }
function clock(value, short = false) { const time = typeof value === 'number' ? value : timestamp(value); return time === null ? '—' : (short ? shortTimeFormat : timeFormat).format(time); }
function dateTime(value) { const time = typeof value === 'number' ? value : timestamp(value); return time === null ? '—' : new Date(time).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'); }
function duration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${Math.floor(seconds % 60)}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function age(value) {
  const time = timestamp(value);
  if (time === null) return 'Unknown age';
  const seconds = Math.max(0, (now() - time) / 1000);
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function stale(agent) { return agent.status !== 'offline' && timestamp(agent.lastSeen) !== null && now() - timestamp(agent.lastSeen) > 120_000; }
function statusOf(agent) { return stale(agent) ? 'stale' : agent.status; }
function capitalize(text) { return text ? text[0].toUpperCase() + text.slice(1) : 'Unknown'; }
function scopedAgents() {
  if (!state.snapshot) return [];
  return state.snapshot.agents.filter((agent) => {
    const haystack = `${agent.name} ${agent.project} ${agent.provider}`.toLowerCase();
    return (!state.search || haystack.includes(state.search.toLowerCase())) &&
      (!state.project || agent.project === state.project) && (!state.provider || agent.provider === state.provider) &&
      (!state.status || (state.status === 'stale' ? stale(agent) : agent.status === state.status));
  });
}
function scope() {
  const agents = scopedAgents();
  const ids = new Set(agents.map((agent) => agent.id));
  const pick = (key) => state.snapshot[key].filter((item) => ids.has(item.agentId));
  return { agents, runs: pick('runs'), handoffs: pick('handoffs'), attention: pick('attention'), events: pick('events') };
}
function agentById(id) { return state.snapshot?.agents.find((agent) => agent.id === id); }
function announce(message) { $('#announcement').textContent = message; }
function connection(connected) {
  state.connected = connected;
  const target = $('#connection');
  target.textContent = state.phase === 'locked' ? 'Locked' : connected ? 'Live stream' : state.snapshot ? 'Reconnecting' : 'Connecting';
  target.className = `connection ${connected ? 'connected' : 'disconnected'}`;
}
function showError(message) {
  const container = $('#error-notice');
  container.hidden = !message;
  container.replaceChildren();
  if (message) append(container, node('span', '', message), button('Retry', 'refresh', '', 'text-button'));
}
function setSnapshot(snapshot) {
  if (snapshot === null) { clearActivity(); return; }
  if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.runs) || !Array.isArray(snapshot.handoffs) || !Array.isArray(snapshot.attention)) {
    showError('The server returned an invalid snapshot. Existing data has been kept.');
    return;
  }
  state.snapshot = snapshot;
  state.receivedAt = Date.now();
  state.clockOffset = (timestamp(snapshot.serverTime) ?? Date.now()) - Date.now();
  showError('');
  render();
}
async function refresh() {
  if (!state.access) { openConnection(); return; }
  const access = state.access;
  const trigger = $('#refresh-button');
  trigger.disabled = true;
  try { await transport.refresh(); }
  finally { if (state.access === access) trigger.disabled = false; }
}
function renderFreshness() {
  $('#freshness').textContent = state.receivedAt ? `${state.connected ? 'Updated' : 'Last received'} ${clock(state.receivedAt)} · local time${state.connected ? '' : ' · reconnecting automatically'}` : state.access ? 'Awaiting first authorized snapshot' : 'Connect to read activity';
}
function updateOptions(selector, values, allLabel, selected) {
  const select = $(selector);
  const next = [...new Set(['', ...values, ...(selected ? [selected] : [])])].sort((a, b) => a.localeCompare(b));
  const existing = [...select.options].map((option) => option.value);
  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    select.replaceChildren(...next.map((value) => node('option', '', value || allLabel, { value })));
  }
  select.value = next.includes(selected) ? selected : '';
}
function renderSummary(data) {
  const working = data.agents.filter((agent) => agent.status === 'working' && !stale(agent)).length;
  const attention = data.attention.filter((item) => !item.resolvedAt).length;
  const offered = data.handoffs.filter((item) => item.status === 'offered').length;
  const running = data.runs.filter((run) => run.status === 'running').length;
  const metrics = [
    [working, 'agents working', ` / ${data.agents.length}`], [attention, 'need attention'],
    [offered, 'open handoffs'], [running, 'runs in progress'],
  ];
  $('#summary').replaceChildren(...metrics.map(([value, label, total]) => {
    const valueNode = node('span', 'metric-value', numberFormat.format(value));
    if (total) valueNode.append(node('span', 'metric-sub', total));
    return append(node('div', 'metric'), valueNode, node('span', 'metric-label', label));
  }));
  const staleCount = data.agents.filter(stale).length;
  $('#finding').textContent = attention
    ? `${attention} ${attention === 1 ? 'request needs' : 'requests need'} a decision.${staleCount ? ` ${staleCount} ${staleCount === 1 ? 'agent has' : 'agents have'} stale activity.` : ' Review the queue or inspect an agent’s activity.'}`
    : data.agents.length ? `No open attention requests.${staleCount ? ` ${staleCount} ${staleCount === 1 ? 'agent has' : 'agents have'} stale activity.` : ' Inspect activity and keep work moving.'}`
      : state.snapshot.agents.length ? 'No agents match this view.' : 'Connect an agent to start observing its activity.';
}
function kindClass(kind) { return `kind-${kinds.includes(kind) ? kind : 'message'}`; }
function legend(events) {
  const present = new Set(events.map((event) => event.kind));
  const group = node('div', 'legend');
  for (const kind of kinds.filter((item) => present.has(item))) {
    append(group, append(node('span', 'legend-item'), node('i', `legend-mark ${kindClass(kind)}`, null, { 'aria-hidden': 'true' }), node('span', '', capitalize(kind))));
  }
  return group;
}
function eventEnd(event) { return event.endedAt ? timestamp(event.endedAt) : now(); }
function bounds(events, useWindow = true) {
  const starts = events.map((event) => timestamp(event.startedAt)).filter((value) => value !== null);
  const ends = events.map(eventEnd).filter((value) => value !== null);
  let end = useWindow && state.window !== 'all' ? now() : Math.max(...ends, ...starts, now());
  let start = starts.length ? Math.min(...starts) : end - 60_000;
  if (useWindow && state.window !== 'all') start = end - Number(state.window) * 60_000;
  else if (events.length && !events.some((event) => !event.endedAt)) end = Math.max(...ends, ...starts);
  if (end - start < 1000) end = start + 1000;
  return { start, end };
}
function axis(start, end) {
  const ticks = node('div', 'axis-times');
  for (let index = 0; index <= 3; index++) {
    const at = start + (end - start) * index / 3;
    const tick = node('span', 'axis-time', clock(at, end - start >= 180_000), { title: dateTime(at) });
    tick.style.left = `${index / 3 * 100}%`;
    ticks.append(tick);
  }
  return ticks;
}
function mark(event, range, view = 'overview') {
  const start = timestamp(event.startedAt);
  const end = eventEnd(event);
  if (start === null || end === null || end < range.start || start > range.end) return null;
  const left = Math.max(0, (start - range.start) / (range.end - range.start) * 100);
  const width = Math.max(0, (Math.min(range.end, end) - Math.max(range.start, start)) / (range.end - range.start) * 100);
  const accessible = `${event.label} · ${event.kind} · ${clock(start)} · ${event.endedAt ? duration(end - start) : 'ongoing'}`;
  const element = button('', 'select-span', event.id, `span-mark ${kindClass(event.kind)}${event.endedAt ? '' : ' open'}${state.selectedSpan === event.id ? ' selected' : ''}`);
  element.dataset.focus = `span:${view}:${event.id}`;
  element.setAttribute('aria-label', accessible);
  element.setAttribute('title', accessible);
  element.style.left = `${Math.min(left, 99.65)}%`;
  element.style.width = `max(3px, ${Math.min(width, 100 - left)}%)`;
  return element;
}
function renderActivity(data) {
  const target = $('#activity');
  $('#agent-count').textContent = data.agents.length;
  target.replaceChildren();
  if (!data.agents.length) {
    target.append(empty(state.snapshot.agents.length ? 'No agents match your filters. Clear the filters to see your workspace.' : 'No connected agents yet. Send events or import a local transcript to begin.'));
    $('#activity-legend').replaceChildren();
    return;
  }
  const range = bounds(data.events);
  append(target, append(node('div', 'activity-axis'), node('span', '', 'Agent / project'), axis(range.start, range.end), node('span', 'axis-label', 'State / last seen')));
  for (const agent of data.agents) {
    const displayStatus = statusOf(agent);
    const row = node('div', `agent-row${agent.id === state.selectedAgent ? ' selected' : ''}`);
    const label = button('', 'select-agent', agent.id, 'agent-name');
    label.setAttribute('aria-label', `Inspect ${agent.name}, ${agent.provider}, ${displayStatus}`);
    label.setAttribute('aria-pressed', String(agent.id === state.selectedAgent));
    append(label, append(node('span', 'agent-primary'), node('i', `status-dot ${displayStatus}`, null, { 'aria-hidden': 'true' }), node('span', 'agent-title', agent.name), node('span', 'provider', agent.provider)), node('span', 'agent-secondary', agent.project));
    const track = node('div', 'lane-track', null, { 'aria-label': `${agent.name} activity` });
    const agentEvents = data.events.filter((event) => event.agentId === agent.id);
    // The overview overlays lanes; the inspector separates them on the same clock.
    for (const event of [...agentEvents].sort((a, b) => timestamp(a.startedAt) - timestamp(b.startedAt))) {
      const segment = mark(event, range);
      if (segment) track.append(segment);
    }
    const readout = append(node('div', 'agent-readout'), node('span', `state-label ${displayStatus}`, capitalize(displayStatus)), node('span', '', age(agent.lastSeen)));
    append(row, label, track, readout);
    target.append(row);
  }
  $('#activity-legend').replaceChildren(...legend(data.events.filter((event) => eventEnd(event) >= range.start && timestamp(event.startedAt) <= range.end)).childNodes);
}
function renderRuns(data) {
  const runs = [...data.runs].sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt));
  $('#run-count').textContent = runs.length;
  $('#toggle-runs').hidden = runs.length <= 5;
  $('#toggle-runs').textContent = state.allRuns ? 'Show recent' : `View all ${runs.length}`;
  if (!runs.length) { $('#runs').replaceChildren(empty('No runs recorded in this view. Runs appear when an integration reports them.')); return; }
  const container = node('div', 'run-list', null, { role: 'table', 'aria-label': 'Recorded runs' });
  const header = node('div', 'run-header', null, { role: 'row' });
  ['Project / model', 'State', 'Checks', 'Duration', 'USD'].forEach((text, index) => header.append(node('span', index > 1 ? 'num' : '', text, { role: 'columnheader' })));
  container.append(header);
  for (const run of state.allRuns ? runs : runs.slice(0, 5)) {
    const row = node('div', 'run-row', null, { role: 'row' });
    const runLink = button(run.project || agentById(run.agentId)?.project || run.id, 'select-agent', run.agentId, 'run-title');
    runLink.dataset.focus = `run:${run.id}`;
    const identity = append(node('div', 'run-name-cell', null, { role: 'cell' }), runLink, node('div', 'run-model', `${run.model || 'Model unknown'} · ${age(run.startedAt)}`));
    const elapsed = timestamp(run.startedAt) === null ? null : (run.endedAt ? timestamp(run.endedAt) : now()) - timestamp(run.startedAt);
    const checks = run.checksPassed === null || run.checksTotal === null ? '—' : `${run.checksPassed}/${run.checksTotal}`;
    append(row, identity, node('span', `run-state ${run.status}`, capitalize(run.status), { role: 'cell' }), node('span', 'num checks-cell', checks, { role: 'cell', 'aria-label': checks === '—' ? 'Checks unknown' : `${checks} checks` }), node('span', 'num duration-cell', duration(elapsed), { role: 'cell' }), node('span', 'num cost-cell', run.cost === null ? '—' : moneyFormat.format(run.cost), { role: 'cell' }));
    if (run.failure) row.append(node('p', 'run-failure', run.failure));
    container.append(row);
  }
  $('#runs').replaceChildren(container);
}
function queueMeta(item, status, kind) {
  const meta = node('div', 'queue-meta');
  const agent = agentById(item.agentId);
  if (agent) {
    const link = button(agent.name, 'select-agent', agent.id, 'text-button');
    link.dataset.focus = `queue-agent:${kind}:${item.id}`;
    meta.append(link);
  }
  if (status) meta.append(node('span', `queue-state ${item.status}`, status));
  meta.append(node('span', '', age(item.createdAt)));
  return meta;
}
function detailDisclosure(text, key) {
  if (!text) return null;
  return append(node('details', 'queue-detail', null, { 'data-details': key }), node('summary', '', 'Details', { 'data-focus': `details:${key}` }), node('p', '', text));
}
function actionButton(text, action, id) {
  const result = button(text, action, id);
  result.disabled = state.pending || !state.access?.writable;
  if (!state.access?.writable) result.setAttribute('title', 'This session has read-only access');
  return result;
}
function renderQueues(data) {
  const attention = data.attention.filter((item) => !item.resolvedAt).sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
  $('#attention-count').textContent = attention.length;
  const attentionList = node('div', 'queue-list');
  for (const item of attention) {
    const actions = append(node('div', 'queue-actions'), actionButton('Resolve', 'resolve', item.id));
    attentionList.append(append(node('article', 'queue-item'), append(node('div', 'queue-top'), node('h3', 'queue-title', item.title), actions), queueMeta(item, null, 'attention'), detailDisclosure(item.detail, `attention:${item.id}`)));
  }
  $('#attention').replaceChildren(attention.length ? attentionList : empty('Nothing needs your attention.'));
  const handoffs = data.handoffs.filter((item) => state.completed || item.status !== 'completed').sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
  $('#handoff-count').textContent = handoffs.length;
  $('#toggle-completed').textContent = state.completed ? 'Hide completed' : 'Show completed';
  $('#toggle-completed').setAttribute('aria-pressed', String(state.completed));
  const list = node('div', 'queue-list');
  for (const item of handoffs) {
    const actions = node('div', 'queue-actions');
    if (item.status === 'offered') actions.append(actionButton('Claim', 'claim', item.id));
    else if (item.status === 'claimed' && (!state.owner || item.owner === state.owner)) append(actions, actionButton('Release', 'release', item.id), actionButton('Complete', 'complete', item.id));
    const label = item.status === 'claimed' ? `Claimed by ${item.owner}` : capitalize(item.status);
    list.append(append(node('article', 'queue-item'), append(node('div', 'queue-top'), node('h3', 'queue-title', item.title), actions), queueMeta(item, label, 'handoff'), detailDisclosure(item.detail, `handoff:${item.id}`)));
  }
  $('#handoffs').replaceChildren(handoffs.length ? list : empty(state.completed ? 'No handoffs in this view.' : 'No open handoffs. Offered work will appear here.'));
}
function selectAgent(id, spanId = null) {
  if (!agentById(id)) return;
  if (!state.selectedAgent) previousScroll = window.scrollY;
  state.selectedAgent = id;
  state.selectedSpan = spanId;
  state.tab = 'waterfall';
  render();
  $('#inspector').scrollIntoView({ block: 'start', behavior: 'instant' });
  $('#inspector-name').focus({ preventScroll: true });
}
function closeInspector() {
  const id = state.selectedAgent;
  state.selectedAgent = null;
  state.selectedSpan = null;
  state.expanded = false;
  render();
  window.scrollTo({ top: previousScroll, behavior: 'instant' });
  [...document.querySelectorAll('[data-action="select-agent"]')].find((element) => element.dataset.id === id)?.focus({ preventScroll: true });
}
function spanDetails(event) {
  if (!event) return empty('Select a segment to inspect its recorded details.');
  const durationText = event.endedAt ? duration(eventEnd(event) - timestamp(event.startedAt)) : `Open · ${duration(now() - timestamp(event.startedAt))}`;
  const details = node('div', 'span-detail');
  append(details, append(node('div', 'span-detail-heading'), node('h3', '', `${capitalize(event.kind)} · ${event.label}`), node('span', 'span-detail-meta', `${dateTime(event.startedAt)} · ${durationText}`)), node('pre', '', event.detail || 'No additional detail was recorded.'));
  return details;
}
function waterfall(events) {
  const content = node('div', 'waterfall');
  if (!events.length) { content.append(empty('No spans have been recorded for this agent.')); return content; }
  const range = bounds(events, false);
  const lanes = [...new Set(events.map((event) => event.laneId))].sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b));
  content.append(append(node('div', 'waterfall-axis'), node('span', '', 'Lane'), axis(range.start, range.end), node('span', 'num', 'Elapsed')));
  for (const lane of lanes) {
    const laneEvents = events.filter((event) => event.laneId === lane).sort((a, b) => timestamp(a.startedAt) - timestamp(b.startedAt));
    const track = node('div', 'lane-track', null, { 'aria-label': `${lane} spans` });
    for (const event of laneEvents) { const segment = mark(event, range, 'inspector'); if (segment) track.append(segment); }
    const start = Math.min(...laneEvents.map((event) => timestamp(event.startedAt)));
    const end = Math.max(...laneEvents.map(eventEnd));
    content.append(append(node('div', 'waterfall-row'), node('span', 'waterfall-label', lane === 'main' ? 'Main agent' : lane, { title: lane }), track, node('span', 'waterfall-duration', duration(end - start))));
  }
  const key = legend(events); key.classList.add('waterfall-footer');
  append(content, key, spanDetails(events.find((event) => event.id === state.selectedSpan)));
  return content;
}
function consoleView(events) {
  const container = node('div', 'console', null, { tabindex: '0', 'aria-label': 'Recorded span details', 'data-focus': 'console-output' });
  if (!events.length) { container.append(empty('No recorded output for this agent.')); return container; }
  for (const event of [...events].sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt))) {
    container.append(append(node('article', 'console-item'), append(node('div', 'console-meta'), node('span', '', clock(event.startedAt)), node('span', '', event.kind), node('span', '', event.laneId)), node('pre', '', [event.label, event.detail].filter(Boolean).join('\n'))));
  }
  return container;
}
function timelineView(events) {
  if (!events.length) return empty('No recorded events for this agent.');
  const list = node('ol', 'timeline-list');
  for (const event of [...events].sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt))) {
    const text = append(node('div', ''), button(event.label, 'timeline-span', event.id), node('p', '', `${capitalize(event.kind)} · ${event.laneId}`));
    list.append(append(node('li', 'timeline-item'), node('time', 'timeline-time', clock(event.startedAt), { datetime: event.startedAt }), node('i', `legend-mark ${kindClass(event.kind)}`, null, { 'aria-hidden': 'true' }), text, node('span', 'num', event.endedAt ? duration(eventEnd(event) - timestamp(event.startedAt)) : 'Open')));
  }
  return list;
}
function renderInspector() {
  const container = $('#inspector');
  const agent = agentById(state.selectedAgent);
  container.hidden = !agent;
  document.body.classList.toggle('expanded', Boolean(agent && state.expanded));
  document.body.classList.toggle('mobile-detail', Boolean(agent));
  if (!agent) { container.replaceChildren(); return; }
  const events = state.snapshot.events.filter((event) => event.agentId === agent.id);
  const header = node('div', 'inspector-header');
  const identity = node('div', '');
  append(identity, append(node('div', 'inspector-heading'), node('h2', '', agent.name, { id: 'inspector-name', tabindex: '-1' }), node('span', 'provider', agent.provider), node('span', 'muted', capitalize(statusOf(agent)))), node('p', 'inspector-path', agent.cwd || agent.project));
  const facts = node('div', 'inspector-facts');
  const context = agent.contextUsed === null ? '—' : `${numberFormat.format(agent.contextUsed)}${agent.contextLimit === null ? ' tokens' : ` / ${numberFormat.format(agent.contextLimit)} tokens`}`;
  for (const [label, value] of [['Started', dateTime(agent.startedAt)], ['Last seen', age(agent.lastSeen)], ['Context', context]]) facts.append(append(node('span', ''), node('span', '', `${label} `), node('strong', '', value)));
  identity.append(facts);
  const source = state.snapshot.provenance?.[agent.id];
  const provenance = node('div', 'inspector-provenance', null, { 'aria-label': 'Source enrollment' });
  if (source) {
    for (const [label, value] of [['Source', source.sourceId], ['Tool instance', source.toolInstanceId], ['Generation', source.generation]]) {
      provenance.append(append(node('span', ''), node('span', '', `${label}: `), node('strong', '', value)));
    }
  }
  const asserted = source?.identity?.evidence === 'operator-asserted' && typeof source.identity.alias === 'string';
  provenance.append(node('span', 'identity-evidence', asserted
    ? `Operator-supplied identity: ${source.identity.alias} · unverified`
    : 'Identity unverified · no operator alias supplied'));
  identity.append(provenance);
  append(header, identity, append(node('div', 'inspector-actions'), button(state.expanded ? 'Back to overview' : 'Expand', 'expand', '', 'text-button'), button('Close', 'close-inspector', '', 'text-button')));
  const tabs = node('div', 'tabs', null, { role: 'tablist', 'aria-label': 'Agent inspection' });
  for (const tab of ['waterfall', 'console', 'timeline']) {
    const control = button(capitalize(tab), 'tab', tab, 'tab');
    for (const [key, value] of Object.entries({ role: 'tab', id: `tab-${tab}`, 'aria-selected': String(state.tab === tab), 'aria-controls': 'inspector-content', tabindex: state.tab === tab ? '0' : '-1' })) control.setAttribute(key, value);
    tabs.append(control);
  }
  const body = node('div', 'inspector-body', null, { id: 'inspector-content', role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}`, tabindex: '0' });
  body.append(node('p', 'inspector-description', state.tab === 'waterfall' ? `${events.length} recorded spans · shared clock across lanes · gaps remain visible` : state.tab === 'console' ? 'Recorded labels and details, newest first. This is not an interactive terminal.' : 'Recorded events, newest first. Select an event to inspect its span.'));
  body.append(state.tab === 'waterfall' ? waterfall(events) : state.tab === 'console' ? consoleView(events) : timelineView(events));
  body.append(node('p', 'inspector-note', 'Span timing reflects what the integration reported. Missing activity is not inferred.'));
  container.replaceChildren(header, tabs, body);
}
function renderOnboarding() {
  const target = $('#onboarding');
  target.hidden = state.snapshot.mode !== 'live' || state.snapshot.agents.length > 0;
  if (target.hidden) return;
  target.replaceChildren(node('h2', '', 'Bring an agent into view'), node('p', '', 'Enroll an explicit transcript file in this domain, or send structured events with its source token. Runward observes activity; it does not execute agents. The example domain and environment labels do not authenticate a provider account.'), node('pre', '', ingestionCommand), node('p', '', 'The ingest command requires RUNWARD_INGEST_TOKEN for an enrolled source. Event API: POST /api/events with that source’s Authorization: Bearer token and a JSON command such as {"type":"agent.upsert","data":{"id":"build-worker","name":"Build worker","project":"My project","provider":"Custom","status":"working"}}. Reader and action tokens cannot ingest events.'), button('Connection details', 'connect', ''));
}
function render() {
  $('#connect-button').textContent = state.access ? 'Session' : 'Connect';
  $('#logout-button').hidden = !state.access && state.phase !== 'connecting';
  $('#lock-button').hidden = !state.access;
  $('#save-operator').hidden = !state.access?.writable;
  $('#access-label').textContent = !state.access ? 'Locked · authentication required' : state.access.writable
    ? `Read and coordinate${state.owner ? ` · alias: ${state.owner}` : ' · no operator alias'}` : 'Read-only access';
  const domain = $('#domain-notice');
  domain.hidden = !state.access;
  domain.replaceChildren();
  if (state.access) append(domain, node('span', '', `Domain: ${state.access.domain.id}`), node('span', '', `Environment: ${state.access.domain.environmentId}`));
  $('#refresh-button').disabled = !state.access;
  for (const control of document.querySelectorAll('#filters input, #filters select, #filters button, #window')) control.disabled = !state.access;
  if (!state.snapshot) {
    $('#finding').textContent = state.access ? 'Waiting for authorized activity from this domain.' : 'Connect with a server token to read this domain’s activity.';
    $('#summary').replaceChildren();
    $('#mode-notice').hidden = true;
    $('#mode-notice').replaceChildren();
    $('#onboarding').hidden = true;
    $('#onboarding').replaceChildren();
    $('#activity').replaceChildren(empty(state.access ? 'Loading authorized activity…' : 'Activity is locked. No agent data is loaded before you connect.'));
    for (const id of ['runs', 'attention', 'handoffs']) $(`#${id}`).replaceChildren(empty(state.access ? 'Loading…' : 'Connect to read this domain.'));
    for (const id of ['agent-count', 'run-count', 'attention-count', 'handoff-count', 'activity-legend']) $(`#${id}`).replaceChildren();
    $('#toggle-runs').hidden = true;
    $('#toggle-runs').textContent = 'View all';
    $('#toggle-completed').disabled = true;
    $('#toggle-completed').textContent = 'Show completed';
    $('#toggle-completed').setAttribute('aria-pressed', 'false');
    $('#clear-filters').hidden = true;
    updateOptions('#project', [], 'All projects', '');
    updateOptions('#provider', [], 'All providers', '');
    renderInspector(); renderFreshness();
    return;
  }
  $('#toggle-completed').disabled = false;
  const focusKey = document.activeElement?.dataset?.focus;
  const focusId = document.activeElement?.id;
  const inspectionScroll = ['.console', '.timeline-list', '.span-detail pre'].map((selector) => [selector, $(selector)?.scrollTop ?? 0]);
  const openDetails = new Set([...document.querySelectorAll('.queue-item details[open]')].map((detail) => detail.dataset.details));
  const data = scope();
  updateOptions('#project', state.snapshot.agents.map((agent) => agent.project), 'All projects', state.project);
  updateOptions('#provider', state.snapshot.agents.map((agent) => agent.provider), 'All providers', state.provider);
  $('#clear-filters').hidden = !(state.search || state.project || state.provider || state.status);
  const mode = $('#mode-notice');
  mode.hidden = state.snapshot.mode !== 'demo';
  if (!mode.hidden) mode.replaceChildren(node('strong', '', 'Demo workspace'), node('span', '', 'Fictional agents and activity. Start without --demo to connect your own workspace.'));
  renderSummary(data); renderActivity(data); renderRuns(data); renderQueues(data); renderInspector(); renderOnboarding(); renderFreshness();
  for (const details of document.querySelectorAll('.queue-item details')) if (openDetails.has(details.dataset.details)) details.open = true;
  for (const [selector, scrollTop] of inspectionScroll) if ($(selector)) $(selector).scrollTop = scrollTop;
  const focused = focusKey ? [...document.querySelectorAll('[data-focus]')].find((element) => element.dataset.focus === focusKey) : focusId ? document.getElementById(focusId) : null;
  focused?.focus({ preventScroll: true });
}
function openConnection() {
  $('#operator-name').value = state.owner;
  $('#access-token').value = '';
  $('#connect-error').hidden = true;
  $('#lock-button').hidden = !state.access;
  $('#save-operator').hidden = !state.access?.writable;
  $('#session-description').textContent = state.access
    ? `Connected to domain ${state.access.domain.id}, environment ${state.access.domain.environmentId}. Enter a server token to replace this session.`
    : 'A server token is required to read activity. Reader tokens allow inspection; action tokens also allow coordination.';
  $('#ingestion-command').textContent = ingestionCommand;
  if (!$('#connect-dialog').open) $('#connect-dialog').showModal();
  $('#access-token').focus();
}
function clearActivity() {
  state.snapshot = null; state.owner = ''; state.selectedAgent = null; state.selectedSpan = null;
  state.expanded = false; state.allRuns = false; state.completed = false; state.pending = false;
  state.receivedAt = 0; state.clockOffset = 0; previousScroll = 0;
  for (const key of ['search', 'project', 'provider', 'status']) { state[key] = ''; $(`#${key}`).value = ''; }
  state.window = 'all'; $('#window').value = 'all';
  $('#operator-name').value = ''; $('#access-token').value = '';
  $('#session-description').textContent = 'A server token is required to read activity. Reader tokens allow inspection; action tokens also allow coordination.';
  $('#announcement').textContent = ''; $('#connect-error').textContent = ''; $('#connect-error').hidden = true;
  showError(''); render();
}
function lock() {
  loginAttempt++;
  transport.logout();
  $('#unlock-button').disabled = false; $('#unlock-button').textContent = 'Connect securely';
  $('#connect-dialog').close(); announce('Session locked. Activity and session credentials cleared.');
}
async function coordinate(action, id) {
  if (!state.access?.writable) { openConnection(); return; }
  if (!state.owner) {
    openConnection();
    $('#connect-error').textContent = 'Enter and save an operator alias before coordinating. This label is not an authenticated identity.';
    $('#connect-error').hidden = false;
    $('#operator-name').focus();
    return;
  }
  if (state.pending) return;
  const access = state.access;
  const type = action === 'resolve' ? 'attention.resolve' : `handoff.${action}`;
  const data = action === 'resolve' ? { id } : { id, owner: state.owner };
  state.pending = true; render();
  try {
    if (!await transport.action({ type, data }) || state.access !== access) return;
    await refresh();
    if (state.access !== access) return;
    announce(action === 'resolve' ? 'Attention request resolved.' : `Handoff ${action === 'claim' ? 'claimed. This assigns the work; no agent was started.' : action === 'release' ? 'released.' : 'completed.'}`);
  } catch (error) {
    if (state.access !== access) return;
    if (error.status === 409) await refresh();
    if (state.access !== access) return;
    showError(error.message);
    announce(error.message);
  } finally { if (state.access === access) { state.pending = false; render(); } }
}

const transport = createConnection({
  onState: setSnapshot,
  onAccess: (access) => { state.access = access; render(); },
  onStatus: ({ phase, message }) => {
    state.phase = phase;
    connection(phase === 'live');
    showError(message); render();
  },
});

$('#filters').addEventListener('submit', (event) => event.preventDefault());
$('#search').addEventListener('input', (event) => { state.search = event.target.value.trim(); render(); });
for (const key of ['project', 'provider', 'status', 'window']) $(`#${key}`).addEventListener('change', (event) => { state[key] = event.target.value; render(); });
$('#status').append(node('option', '', 'Unknown', { value: 'unknown' }));
$('#clear-filters').addEventListener('click', () => { for (const key of ['search', 'project', 'provider', 'status']) { state[key] = ''; $(`#${key}`).value = ''; } render(); $('#search').focus(); });
$('#refresh-button').addEventListener('click', refresh);
$('#connect-button').addEventListener('click', openConnection);
$('#close-dialog').addEventListener('click', () => $('#connect-dialog').close());
$('#connect-dialog').addEventListener('close', () => { $('#access-token').value = ''; });
$('#lock-button').addEventListener('click', lock);
$('#logout-button').addEventListener('click', lock);
$('#save-operator').addEventListener('click', () => {
  if (!state.access?.writable) return;
  const owner = $('#operator-name').value.trim();
  if (!owner) { $('#operator-name').focus(); return; }
  state.owner = owner;
  $('#connect-dialog').close(); render(); announce('Operator alias saved for this session. It is not an authenticated identity.');
});
$('#toggle-runs').addEventListener('click', () => { state.allRuns = !state.allRuns; render(); });
$('#toggle-completed').addEventListener('click', () => { state.completed = !state.completed; render(); });
$('#connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  let token = $('#access-token').value.trim();
  const owner = $('#operator-name').value.trim();
  if (!token) return;
  const attempt = ++loginAttempt;
  $('#access-token').value = '';
  const unlock = $('#unlock-button'); unlock.disabled = true; unlock.textContent = 'Connecting…';
  const error = $('#connect-error'); error.hidden = true;
  try {
    const connecting = transport.login(token);
    token = '';
    const result = await connecting;
    if (!result || attempt !== loginAttempt || state.access !== result) return;
    state.owner = result.writable ? owner : '';
    $('#connect-dialog').close(); render(); announce(result.writable ? 'Connected with read and coordination access.' : 'Connected with read-only access.');
  } catch (reason) { if (attempt === loginAttempt) { error.textContent = reason.message; error.hidden = false; } }
  finally { token = ''; if (attempt === loginAttempt) { unlock.disabled = false; unlock.textContent = 'Connect securely'; } }
});
document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled) return;
  const { action, id } = control.dataset;
  if (action === 'select-agent') selectAgent(id);
  else if (action === 'select-span') { const span = state.snapshot?.events.find((item) => item.id === id); if (span) selectAgent(span.agentId, span.id); }
  else if (action === 'timeline-span') { state.selectedSpan = id; state.tab = 'waterfall'; renderInspector(); $('#tab-waterfall').focus(); }
  else if (action === 'tab') { state.tab = id; renderInspector(); $(`#tab-${id}`).focus(); }
  else if (action === 'expand') { state.expanded = !state.expanded; render(); $('#inspector').scrollIntoView({ block: 'start', behavior: 'instant' }); }
  else if (action === 'close-inspector') closeInspector();
  else if (action === 'connect') openConnection();
  else if (action === 'refresh') refresh();
  else if (['claim', 'release', 'complete', 'resolve'].includes(action)) coordinate(action, id);
});
document.addEventListener('keydown', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const names = ['waterfall', 'console', 'timeline'];
    const current = names.indexOf(state.tab);
    state.tab = event.key === 'Home' ? names[0] : event.key === 'End' ? names[2] : names[(current + (event.key === 'ArrowRight' ? 1 : 2)) % names.length];
    renderInspector(); $(`#tab-${state.tab}`).focus();
  }
  if (event.key === 'Escape' && state.selectedAgent && !$('#connect-dialog').open) closeInspector();
});
window.addEventListener('pagehide', lock);
setInterval(() => { if (state.snapshot && !document.hidden && !$('#connect-dialog').open) render(); }, 15_000);
render();
