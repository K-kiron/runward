import { styles } from './style.mjs';

const kinds = ['thinking', 'tool', 'subagent', 'error', 'message'];
const kindNames = { thinking: 'Thinking', tool: 'Tools', subagent: 'Subagents', error: 'Errors', message: 'Messages' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '') => typeof value === 'string' && value ? value : fallback;
const time = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const clock = value => new Date(value).toISOString().slice(11, 19);
const dateTime = value => time(value) === null ? 'Unknown' : new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC');
const statusNames = { working: 'Working', running: 'Running', idle: 'Idle', finished: 'Finished', paused: 'Paused', waiting: 'Waiting', waiting_for_confirmation: 'Waiting for confirmation', offline: 'Offline', error: 'Error', stuck: 'Stuck', unknown: 'Unknown' };
const statusName = value => Object.hasOwn(statusNames, value) ? statusNames[value] : 'Unknown';

function duration(start, end) {
  if (end === null) return 'Result not observed';
  const milliseconds = time(end) - time(start);
  if (!milliseconds) return 'Instant';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60000);
  return `${minutes}m ${Math.floor(milliseconds / 1000) % 60}s`;
}

function checkedList(value) {
  if (!object(value) || !Array.isArray(value.conversations) || !Array.isArray(value.warnings) ||
      value.conversations.some(item => !object(item) || typeof item.id !== 'string' || !item.id)) throw new Error('Invalid conversation list');
  return value;
}

function checkedSnapshot(value) {
  if (!object(value) || !Array.isArray(value.spans) || !Array.isArray(value.untimedEvents) || !Array.isArray(value.warnings) ||
      !Number.isSafeInteger(value.eventCount) || value.eventCount < 0 ||
      value.spans.some(span => !object(span) || typeof span.id !== 'string' || !span.id || !kinds.includes(span.kind) ||
        time(span.startedAt) === null || (span.endedAt !== null && (time(span.endedAt) === null || time(span.endedAt) < time(span.startedAt)))) ||
      value.untimedEvents.some(event => !object(event) || typeof event.id !== 'string' || !event.id)) throw new Error('Invalid conversation data');
  return value;
}

/** Mount a read-only view. Cleanup is synchronous; late client responses are ignored. */
export function mountPage({ container, client, backendLabel }) {
  const document = container.ownerDocument;
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const node = (tag, className, value, attributes = {}) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    for (const [name, attribute] of Object.entries(attributes)) element.setAttribute(name, String(attribute));
    return element;
  };
  const append = (parent, ...children) => { parent.append(...children); return parent; };
  const button = (label, action, id = '') => node('button', '', label, { type: 'button', 'data-action': action, 'data-id': id });
  const empty = value => node('p', 'empty', value);
  const style = node('style', '', styles);
  const app = node('main', 'app', undefined, { 'aria-label': 'Runward conversation activity' });
  const picker = node('select', '', undefined, { id: 'conversation', 'aria-label': 'Conversation' });
  picker.append(node('option', '', 'Loading conversations…', { value: '' }));
  const refreshButton = button('Refresh', 'refresh');
  const autoInput = node('input', '', undefined, { type: 'checkbox', 'data-control': 'auto' });
  const freshness = node('p', 'freshness', 'Loading conversations…', { role: 'status', 'aria-live': 'polite' });
  const errorNotice = node('p', 'error', '', { role: 'alert' });
  errorNotice.hidden = true;
  const offsetInput = node('input', '', undefined, { id: 'utc-offset', type: 'text', placeholder: '+00:00', maxlength: '6', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'offset-help offset-error' });
  const offsetForm = node('form', 'offset-form');
  const applyButton = node('button', '', 'Apply', { type: 'submit' });
  append(offsetForm, append(node('div', 'field'), node('label', '', 'Server UTC offset', { for: 'utc-offset' }), offsetInput), applyButton);
  const timingTitle = node('h2', '', 'Timestamps');
  const timingCopy = node('p', 'timing-copy', '', { id: 'offset-help' });
  const offsetError = node('p', 'offset-error', '', { id: 'offset-error', role: 'alert' });
  offsetError.hidden = true;
  const timingDetails = append(node('details'), node('summary', '', 'Which offset should I use?'), node('p', '', 'Enter the server’s UTC offset at the time the events were recorded, such as +05:30 or -04:00. This is a fixed offset, not a timezone: daylight-saving changes and historical offset changes are not resolved. Timezone-aware originals keep their reported timezone. Leave the field blank and Apply to clear the assumption.'));
  const facts = node('div', 'facts', undefined, { 'aria-label': 'Conversation summary' });
  const warnings = node('details', 'warnings');
  warnings.hidden = true;
  const warningSummary = node('summary');
  const warningList = node('ul');
  append(warnings, warningSummary, warningList);
  const waterfall = node('div', 'waterfall', undefined, { tabindex: '0', 'aria-label': 'Shared-clock waterfall, UTC' });
  const waterfallCount = node('span', 'count');
  const waterfallNote = node('p', 'section-note');
  const legend = node('div', 'legend', undefined, { 'aria-label': 'Event kinds' });
  for (const kind of kinds) append(legend, append(node('span', 'legend-item'), node('i', `legend-mark kind-${kind}`, undefined, { 'aria-hidden': 'true' }), node('span', '', kindNames[kind])));
  const consoleList = node('div', 'console', undefined, { tabindex: '0', 'aria-label': 'Timed event console' });
  const consoleCount = node('span', 'count');
  const moreEvents = button('Show more events', 'more-events');
  moreEvents.className = 'more';
  const detailTitle = node('h3', '', 'Select an event');
  const detailMeta = node('dl', 'detail-meta');
  const detailPre = node('pre', 'detail-pre', 'Select a timeline segment or an event below to inspect its recorded detail.', { tabindex: '0', 'aria-label': 'Recorded event detail' });
  const untimedPanel = node('section', 'panel untimed-panel', undefined, { 'aria-labelledby': 'untimed-heading' });
  const untimedCount = node('span', 'count');
  const untimedList = node('ul', 'untimed-list', undefined, { tabindex: '0', 'aria-label': 'Events without resolved time' });
  const moreUntimed = button('Show more untimed events', 'more-untimed');
  moreUntimed.className = 'more';
  append(untimedPanel, append(node('div', 'panel-heading'), append(node('h2', '', 'Untimed events', { id: 'untimed-heading' }), untimedCount)), node('p', 'section-note', 'These records have no resolved UTC time. Their original timestamp text is shown without assuming the server’s timezone.'), untimedList, moreUntimed);
  append(app,
    append(node('header', 'topbar'), append(node('span', 'brand'), node('span', 'brand-mark', '→', { 'aria-hidden': 'true' }), node('span', '', 'runward')), node('span', 'backend', text(backendLabel, 'OpenHands')), node('span', 'badge', 'Read only')),
    append(node('div', 'heading'), append(node('div'), node('h1', '', 'Conversation activity'), node('p', '', 'Inspect recorded work on a shared clock.'))),
    append(node('div', 'toolbar'), append(node('div', 'field'), node('label', '', 'Conversation', { for: 'conversation' }), picker), append(node('div', 'actions'), refreshButton, append(node('label', 'auto-refresh'), autoInput, node('span', '', 'Refresh every 5s')))),
    freshness, errorNotice,
    append(node('section', 'timing', undefined, { 'aria-label': 'Timestamp interpretation' }), append(node('div', 'timing-heading'), timingTitle, offsetForm), timingCopy, offsetError, timingDetails),
    facts, warnings,
    append(node('section', 'panel', undefined, { 'aria-labelledby': 'waterfall-heading' }), append(node('div', 'panel-heading'), append(node('h2', '', 'Activity waterfall', { id: 'waterfall-heading' }), waterfallCount)), waterfallNote, waterfall, legend),
    untimedPanel,
    append(node('div', 'lower-grid'),
      append(node('section', 'panel', undefined, { 'aria-labelledby': 'console-heading' }), append(node('div', 'panel-heading'), append(node('h2', '', 'Event console', { id: 'console-heading' }), consoleCount)), consoleList, moreEvents),
      append(node('section', 'panel', undefined, { 'aria-labelledby': 'detail-heading' }), append(node('div', 'panel-heading'), node('h2', '', 'Event detail', { id: 'detail-heading' })), append(node('div', 'detail-content'), detailTitle, detailMeta, detailPre))),
    node('p', 'footer', 'Read-only observations. An open tool means its result was not observed; it does not prove the tool is still running.'));
  root.append(style, app);
  container.append(host);

  const state = { conversations: [], listWarnings: [], listLoaded: false, selectedId: '', selectedEvent: '', offset: '', snapshot: null, updatedAt: 0, auto: false, eventLimit: 100, untimedLimit: 100 };
  let disposed = false;
  let busy = false;
  let version = 0;
  let pending = null;
  let timer;
  let focusTargets = new Map();
  let detailEventId = '';

  function setError(message = '') {
    errorNotice.textContent = message;
    errorNotice.hidden = !message;
  }

  function renderOptions() {
    const options = state.conversations.map(item => ({ id: item.id, label: `${text(item.title, item.id)} · ${statusName(item.status)}` }));
    if (!options.length) options.push({ id: '', label: 'No conversations available' });
    // Keep the select and unchanged options intact while the user is navigating them.
    const previous = [...picker.options].map(option => ({ id: option.value, label: option.textContent }));
    if (JSON.stringify(options) !== JSON.stringify(previous)) picker.replaceChildren(...options.map(option => node('option', '', option.label, { value: option.id })));
    picker.value = state.selectedId;
    picker.disabled = !state.conversations.length;
  }

  function eventButton(span, className, focusKey) {
    const element = button(text(span.label, 'Recorded event'), 'select-event', span.id);
    element.className = `${className} kind-${span.kind}`;
    element.dataset.focus = focusKey;
    element.setAttribute('aria-pressed', String(state.selectedEvent === span.id));
    focusTargets.set(focusKey, element);
    return element;
  }

  function renderWaterfall(spans) {
    waterfallCount.textContent = String(spans.length);
    waterfallNote.textContent = 'UTC · grouped by event kind, not separate agents. Dotted markers have no observed result; their duration is unknown.';
    waterfall.replaceChildren();
    if (!spans.length) {
      waterfall.append(empty(state.snapshot?.data.untimedEvents.length
        ? 'No resolved timeline yet. Review untimed records below or apply the server’s UTC offset.'
        : state.snapshot ? 'No timestamped spans in this conversation.' : state.selectedId ? 'Loading conversation activity…' : 'Select a conversation to inspect its activity.'));
      return;
    }
    const ordered = [...spans].sort((a, b) => time(a.startedAt) - time(b.startedAt));
    const minimum = Math.min(...ordered.map(span => time(span.startedAt)));
    const maximum = Math.max(...ordered.map(span => time(span.endedAt) ?? time(span.startedAt)));
    const range = Math.max(1, maximum - minimum);
    append(waterfall, append(node('div', 'axis'), node('span', '', 'UTC'), append(node('div', 'axis-times'), node('span', '', clock(minimum)), node('span', 'axis-mid', clock(minimum + range / 2)), node('span', '', clock(maximum)))));
    const shown = ordered.slice(0, 300);
    if (shown.length < ordered.length) waterfallNote.textContent += ' Showing the first 300 spans; the event console includes the remaining spans.';
    for (const kind of kinds) {
      const matching = shown.filter(span => span.kind === kind);
      if (!matching.length) continue;
      const tracks = [];
      for (const span of matching) {
        const started = time(span.startedAt);
        const ended = time(span.endedAt) ?? started;
        let track = tracks.find(item => item.end < started);
        if (!track) { track = { end: -Infinity, spans: [] }; tracks.push(track); }
        track.spans.push(span);
        track.end = ended;
      }
      const trackGroup = node('div');
      for (const track of tracks) {
        const lane = node('div', 'lane-track');
        for (const span of track.spans) {
          const mark = eventButton(span, `span-mark${span.endedAt === null ? ' open' : ''}`, `waterfall:${span.id}`);
          mark.textContent = '';
          const left = 100 * (time(span.startedAt) - minimum) / range;
          const width = Math.max(0, 100 * ((time(span.endedAt) ?? time(span.startedAt)) - time(span.startedAt)) / range);
          // Keep instant markers at the right boundary inside the scroll area.
          mark.style.left = `min(${left}%, calc(100% - 7px))`;
          mark.style.width = `${Math.min(100 - left, width)}%`;
          const label = `${text(span.label, kindNames[kind])} · ${dateTime(span.startedAt)} · ${duration(span.startedAt, span.endedAt)}`;
          mark.setAttribute('aria-label', label);
          mark.title = label;
          lane.append(mark);
        }
        trackGroup.append(lane);
      }
      waterfall.append(append(node('div', 'lane'), node('span', 'lane-name', kindNames[kind]), trackGroup));
    }
  }

  function renderDetail() {
    const span = state.snapshot?.data.spans.find(item => item.id === state.selectedEvent);
    detailTitle.textContent = span ? text(span.label, 'Recorded event') : 'Select an event';
    detailMeta.replaceChildren();
    if (span) for (const [key, value] of [['Kind', kindNames[span.kind]], ['Event ID', span.id], ['Started', dateTime(span.startedAt)], ['Ended', span.endedAt === null ? 'Not observed' : dateTime(span.endedAt)], ['Duration', duration(span.startedAt, span.endedAt)]]) append(detailMeta, node('dt', '', key), node('dd', '', value));
    const scroll = detailEventId === span?.id ? detailPre.scrollTop : 0;
    detailPre.textContent = span ? text(span.detail, 'No readable detail was recorded.') : 'Select a timeline segment or an event to inspect its recorded detail.';
    detailPre.scrollTop = scroll;
    detailEventId = span?.id ?? '';
  }

  function render() {
    if (disposed) return;
    const focus = root.activeElement?.dataset.focus;
    const scrolls = [waterfall, consoleList, untimedList].map(element => element.scrollTop);
    focusTargets = new Map();
    const data = state.snapshot?.data;
    const spans = data?.spans ?? [];
    if (!spans.some(span => span.id === state.selectedEvent)) state.selectedEvent = '';
    const assumption = state.snapshot?.offset ?? state.offset;
    timingTitle.textContent = data?.timingBasis === 'fixed-offset' ? 'User-supplied fixed UTC offset' : 'Timestamps';
    timingCopy.textContent = assumption
      ? `User-supplied fixed UTC offset ${assumption}. It is applied only to timestamps without a timezone; timezone-aware originals remain unchanged. Daylight-saving and historical changes are not resolved.`
      : 'No UTC offset applied. Timestamps without a timezone remain untimed. Enter the server’s recorded offset and Apply to place those events on the timeline.';
    const combinedWarnings = [...state.listWarnings, ...(data?.warnings ?? [])].filter(value => typeof value === 'string' && value);
    warnings.hidden = !combinedWarnings.length;
    warningSummary.textContent = `${combinedWarnings.length} ${combinedWarnings.length === 1 ? 'warning' : 'warnings'}`;
    warningList.replaceChildren(...combinedWarnings.map(value => node('li', '', value)));
    facts.replaceChildren(...[[data?.eventCount ?? '—', 'source events'], [spans.length, 'timed spans'], [data?.untimedEvents.length ?? 0, 'untimed events'], [statusName(data?.status), 'recorded status']].map(([value, label]) => append(node('div', 'fact'), node('strong', '', value), node('span', '', label))));
    renderWaterfall(spans);
    consoleCount.textContent = String(spans.length);
    consoleList.replaceChildren();
    const ordered = [...spans].sort((a, b) => time(a.startedAt) - time(b.startedAt));
    for (const span of ordered.slice(0, state.eventLimit)) {
      const trigger = eventButton(span, 'event-button', `console:${span.id}`);
      trigger.replaceChildren(node('i', `legend-mark kind-${span.kind}`, undefined, { 'aria-hidden': 'true' }), node('span', 'event-label', text(span.label, 'Recorded event')));
      const preview = text(span.detail);
      consoleList.append(append(node('div', 'event-item'), trigger, node('p', 'event-meta', `${dateTime(span.startedAt)} · ${duration(span.startedAt, span.endedAt)}`), node('p', 'event-preview', preview.length > 180 ? `${preview.slice(0, 180)}…` : preview)));
    }
    if (!spans.length) consoleList.append(empty(data?.untimedEvents.length ? 'Untimed event metadata is available above.' : 'No timed events to inspect.'));
    moreEvents.hidden = state.eventLimit >= spans.length;
    moreEvents.textContent = `Show more events (${Math.min(state.eventLimit, spans.length)} of ${spans.length})`;
    const untimed = data?.untimedEvents ?? [];
    untimedPanel.hidden = !untimed.length;
    untimedCount.textContent = String(untimed.length);
    untimedList.replaceChildren(...untimed.slice(0, state.untimedLimit).map(event => append(node('li', 'untimed-item'), node('span', 'untimed-kind', kindNames[event.kind] ?? text(event.kind, 'Unknown')), node('span', '', text(event.label, 'Recorded event')), node('span', 'untimed-time', `Original timestamp: ${text(event.rawTimestamp, 'Not recorded')} · ID: ${event.id}`))));
    moreUntimed.hidden = state.untimedLimit >= untimed.length;
    moreUntimed.textContent = `Show more untimed events (${Math.min(state.untimedLimit, untimed.length)} of ${untimed.length})`;
    renderDetail();
    [waterfall, consoleList, untimedList].forEach((element, index) => { element.scrollTop = scrolls[index]; });
    if (focus) (focusTargets.get(focus) ?? (focus.startsWith('waterfall:') ? waterfall : consoleList)).focus({ preventScroll: true });
  }

  function showProgress() {
    if (disposed) return;
    refreshButton.setAttribute('aria-disabled', String(busy));
    refreshButton.textContent = busy ? 'Refreshing…' : 'Refresh';
    app.setAttribute('aria-busy', String(busy));
    if (busy) freshness.textContent = state.snapshot ? 'Refreshing… showing the previous snapshot until the next response.' : state.listLoaded ? 'Loading conversation activity…' : 'Loading conversations…';
    else freshness.textContent = state.updatedAt ? `Last refreshed ${clock(state.updatedAt)} UTC · ${state.auto ? 'automatic refresh enabled' : 'manual refresh'}` : state.listLoaded && !state.conversations.length ? 'No conversations available. Start or select a conversation in your backend, then Refresh.' : 'No snapshot received. Use Refresh to try again.';
  }

  function schedule() {
    clearTimeout(timer);
    if (!disposed && state.auto && !busy) timer = setTimeout(() => request(true), 5000);
  }

  async function drain() {
    if (busy || disposed) return;
    busy = true;
    showProgress();
    while (pending && !disposed) {
      const job = pending;
      pending = null;
      const current = () => !disposed && version === job.version;
      let phase = 'conversations';
      try {
        if (job.list) {
          const result = checkedList(await client.listConversations({ isActive: current }));
          if (!current()) continue;
          state.conversations = result.conversations;
          state.listWarnings = result.warnings;
          state.listLoaded = true;
          if (!state.conversations.some(item => item.id === state.selectedId)) {
            state.selectedId = state.conversations[0]?.id ?? '';
            state.snapshot = null;
            state.selectedEvent = '';
            state.updatedAt = 0;
            state.eventLimit = state.untimedLimit = 100;
          }
          renderOptions();
          render();
        }
        if (!state.selectedId) { setError(); continue; }
        phase = 'activity';
        const id = state.selectedId;
        const utcOffset = state.offset;
        const result = checkedSnapshot(await client.readConversation(id, { utcOffset, isActive: current }));
        if (!current()) continue;
        state.snapshot = { data: result, offset: utcOffset };
        state.updatedAt = Date.now();
        setError();
        render();
      } catch {
        if (current()) setError(`Could not load ${phase}. Check the backend connection and version, then Refresh to try again.${state.snapshot ? ' The previous snapshot is still shown.' : ''}`);
      }
    }
    busy = false;
    showProgress();
    schedule();
  }

  function request(list = false) {
    if (disposed) return;
    clearTimeout(timer);
    pending = { version: ++version, list: list || !state.listLoaded || Boolean(pending?.list) };
    void drain();
  }

  function click(event) {
    const target = event.target.closest?.('button[data-action]');
    if (!target || disposed) return;
    switch (target.dataset.action) {
      case 'refresh': if (!busy) request(true); break;
      case 'select-event':
        state.selectedEvent = target.dataset.id;
        for (const element of root.querySelectorAll('button[data-action="select-event"]')) element.setAttribute('aria-pressed', String(element.dataset.id === state.selectedEvent));
        renderDetail();
        break;
      case 'more-events': state.eventLimit += 100; render(); if (moreEvents.hidden) consoleList.focus({ preventScroll: true }); break;
      case 'more-untimed': state.untimedLimit += 100; render(); if (moreUntimed.hidden) untimedList.focus({ preventScroll: true }); break;
    }
  }

  function change(event) {
    if (disposed) return;
    if (event.target === picker) {
      state.selectedId = picker.value;
      state.selectedEvent = '';
      state.snapshot = null;
      state.updatedAt = 0;
      state.eventLimit = state.untimedLimit = 100;
      setError();
      render();
      request();
    } else if (event.target === autoInput) {
      state.auto = autoInput.checked;
      schedule();
      showProgress();
    }
  }

  function submit(event) {
    if (event.target !== offsetForm || disposed) return;
    event.preventDefault();
    const offset = offsetInput.value.trim();
    if (offset && (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/u.test(offset) || /^[+-]14:(?!00)/u.test(offset))) {
      offsetError.textContent = 'Use a fixed UTC offset from -14:00 to +14:00, such as +05:30, or leave it blank.';
      offsetError.hidden = false;
      offsetInput.setAttribute('aria-invalid', 'true');
      offsetInput.focus();
      return;
    }
    offsetError.hidden = true;
    offsetInput.removeAttribute('aria-invalid');
    state.offset = offset;
    request();
  }

  root.addEventListener('click', click);
  root.addEventListener('change', change);
  root.addEventListener('submit', submit);
  render();
  request(true);
  return () => {
    if (disposed) return;
    disposed = true;
    version += 1;
    pending = null;
    clearTimeout(timer);
    root.removeEventListener('click', click);
    root.removeEventListener('change', change);
    root.removeEventListener('submit', submit);
    focusTargets.clear();
    host.remove();
  };
}
