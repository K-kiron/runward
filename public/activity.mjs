export const DEFAULT_WINDOW_MINUTES = 5;

// Activity is producer evidence, never the receipt time or an inferred open-span end.
export function activityTime(value, now) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!days || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now ? time : null;
}

export function eventActivityTime(event, now) {
  const start = activityTime(event.startedAt, now);
  if (start === null) return null;
  const end = activityTime(event.endedAt, now);
  return end !== null && end >= start ? end : start;
}

// Display the gap since a recent Working report separately from measured spans.
// This is not a heartbeat and must never feed admission, ordering or durations.
export function awaitingEventRange(agent, latestActivity, now) {
  if (agent.status !== 'working' || !Number.isFinite(latestActivity) ||
      latestActivity >= now || now - latestActivity > 120_000) return null;
  return { start: latestActivity, end: now };
}

export function recentActivity(snapshot, { now, windowMinutes = DEFAULT_WINDOW_MINUTES }) {
  const minutes = [5, 15, 60].includes(Number(windowMinutes)) ? Number(windowMinutes) : DEFAULT_WINDOW_MINUTES;
  const range = { start: now - minutes * 60_000, end: now };
  const latestActivity = new Map(snapshot.agents.map(agent => [agent.id, activityTime(agent.lastSeen, now)]));
  for (const event of snapshot.events) {
    const time = eventActivityTime(event, now);
    if (time !== null && latestActivity.has(event.agentId) && (latestActivity.get(event.agentId) === null || time > latestActivity.get(event.agentId))) latestActivity.set(event.agentId, time);
  }
  const agents = snapshot.agents.filter(agent => latestActivity.get(agent.id) !== null && latestActivity.get(agent.id) >= range.start)
    .sort((a, b) => latestActivity.get(b.id) - latestActivity.get(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(agents.map(agent => agent.id));
  const pick = key => snapshot[key].filter(item => ids.has(item.agentId));
  return { agents, latestActivity, range,
    events: pick('events').filter(event => {
      const time = eventActivityTime(event, now);
      return time !== null && time >= range.start;
    }),
    runs: pick('runs'), handoffs: pick('handoffs'), attention: pick('attention'),
  };
}

export function groupActivityByProvider(agents, latestActivity) {
  const groups = new Map();
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  for (const agent of agents) {
    const supplied = typeof agent.provider === 'string' ? agent.provider.trim() : '';
    const provider = supplied.toLowerCase();
    const key = ['claude', 'claude code'].includes(provider) ? 'claude' : provider || 'unknown';
    const label = key === 'codex' ? 'Codex' : key === 'claude' ? 'Claude Code' : key === 'unknown' ? 'Unknown platform' : supplied;
    if (!groups.has(key)) groups.set(key, { key, label, agents: [] });
    const group = groups.get(key);
    if (compare(label, group.label) < 0) group.label = label;
    group.agents.push(agent);
  }
  for (const group of groups.values()) {
    group.agents.sort((a, b) => (latestActivity.get(b.id) ?? -Infinity) - (latestActivity.get(a.id) ?? -Infinity) || compare(a.id, b.id));
  }
  const rank = key => key === 'codex' ? 0 : key === 'claude' ? 1 : 2;
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || compare(a.key, b.key));
}
