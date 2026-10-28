import { applyCommands, emptyState } from './model.mjs';

export function demoState(now = new Date().toISOString()) {
  const at = secondsAgo => new Date(new Date(now).getTime() - secondsAgo * 1000).toISOString();
  const commands = [];
  const add = (type, data) => commands.push({ type, data });
  const agents = [
    ['atlas-api', 'API migration', 'Atlas', 'Claude', 'working', 4, 68400, 200000],
    ['atlas-tests', 'Contract checks', 'Atlas', 'Codex', 'working', 8, 38200, 128000],
    ['relay-sync', 'Sync worker', 'Relay', 'Codex', 'waiting', 14, 51400, 128000],
    ['relay-docs', 'Release notes', 'Relay', 'Claude', 'idle', 42, 21600, 200000],
    ['moss-index', 'Search indexing', 'Moss', 'Custom', 'working', 6, null, null],
    ['moss-audit', 'Dependency audit', 'Moss', 'Claude', 'offline', 480, 19200, 200000],
  ];
  for (const [id, name, project, provider, status, seen, contextUsed, contextLimit] of agents) {
    add('agent.upsert', { id, name, project, provider, status, lastSeen: at(seen), startedAt: at(1440), cwd: `/workspace/${project.toLowerCase()}`, contextUsed, contextLimit });
  }

  const spans = [
    ['atlas-api', 'main', 'Review migration constraints', 'thinking', 900, 862, 'Compare the existing response contract with the proposed pagination format.'],
    ['atlas-api', 'main', 'Inspect route handlers', 'tool', 852, 760, 'Read the endpoint and its contract tests.'],
    ['atlas-api', 'main', 'Delegate contract checks', 'subagent', 750, 738, 'Start independent schema and fixture checks.'],
    ['atlas-api', 'schema-check', 'Check response schemas', 'tool', 732, 535, 'Validate the response schema against representative payloads.'],
    ['atlas-api', 'fixture-check', 'Inspect boundary cases', 'thinking', 724, 661, 'Review empty pages, absent cursors, and page-size boundaries.'],
    ['atlas-api', 'fixture-check', 'Run fixture matrix', 'tool', 646, 424, 'Exercise a synthetic fixture matrix across supported page sizes.'],
    ['atlas-api', 'main', 'Update cursor handling', 'tool', 720, 532, 'Apply the new cursor shape to the API adapter.'],
    ['atlas-api', 'main', 'Check failed assertion', 'error', 522, 501, 'The empty-page fixture expected an omitted cursor, but received null.'],
    ['atlas-api', 'main', 'Align empty-page behavior', 'thinking', 483, 441, 'Preserve the documented optional cursor behavior.'],
    ['atlas-api', 'main', 'Run integration suite', 'tool', 412, null, 'Integration checks are still running.'],
    ['atlas-tests', 'main', 'Read contract fixtures', 'tool', 660, 574, 'Load synthetic contract fixtures.'],
    ['atlas-tests', 'main', 'Review compatibility', 'thinking', 548, 481, 'Check caller expectations for missing optional fields.'],
    ['atlas-tests', 'main', 'Exercise API boundaries', 'tool', 450, null, 'Boundary checks are in progress.'],
    ['relay-sync', 'main', 'Run sync validation', 'tool', 820, 610, 'Validate the local retry configuration.'],
    ['relay-sync', 'main', 'Retry budget exceeded', 'error', 608, 591, 'The simulated upstream outage exceeded the configured retry budget.'],
    ['relay-sync', 'main', 'Request retry policy decision', 'message', 560, 560, 'Waiting for the maintainer to choose the intended retry budget.'],
    ['relay-docs', 'main', 'Read release changes', 'tool', 1170, 1030, 'Review merged changes in the synthetic release set.'],
    ['relay-docs', 'main', 'Write release notes', 'tool', 1000, 920, 'Prepare the release note draft.'],
    ['relay-docs', 'main', 'Notes ready for review', 'message', 910, 910, 'Release notes are ready for a maintainer review.'],
    ['moss-index', 'main', 'Read index schema', 'tool', 720, 620, 'Inspect the search index schema.'],
    ['moss-index', 'main', 'Plan incremental rebuild', 'thinking', 600, 550, 'Determine which synthetic documents need reindexing.'],
    ['moss-index', 'main', 'Rebuild search index', 'tool', 525, null, 'Reindexing the local sample collection.'],
    ['moss-audit', 'main', 'Inspect dependency tree', 'tool', 1370, 1160, 'Inspect package metadata and pinned versions.'],
    ['moss-audit', 'main', 'Summarize audit', 'message', 1090, 1090, 'Audit summary prepared; the session is now offline.'],
  ];
  spans.forEach(([agentId, laneId, label, kind, start, end, detail], index) => {
    add('span.upsert', { id: `demo-span-${index + 1}`, agentId, laneId, label, kind, startedAt: at(start), endedAt: end === null ? null : at(end), detail });
  });
  add('run.upsert', { id: 'atlas-integration', agentId: 'atlas-api', project: 'Atlas', model: 'Local example', status: 'running', startedAt: at(900), checksPassed: 18, checksTotal: 24 });
  add('run.upsert', { id: 'relay-validation', agentId: 'relay-sync', project: 'Relay', model: 'Local example', status: 'failed', startedAt: at(820), endedAt: at(591), checksPassed: 11, checksTotal: 12, cost: 0.18, failure: 'Retry-budget check failed against the simulated upstream outage.' });
  add('run.upsert', { id: 'relay-release', agentId: 'relay-docs', project: 'Relay', model: 'Local example', status: 'passed', startedAt: at(1170), endedAt: at(910), checksPassed: 8, checksTotal: 8, cost: 0.09 });
  add('run.upsert', { id: 'moss-audit-run', agentId: 'moss-audit', project: 'Moss', model: 'Local example', status: 'passed', startedAt: at(1370), endedAt: at(1090) });
  add('attention.open', { id: 'retry-decision', agentId: 'relay-sync', title: 'Choose the retry budget', detail: 'The outage simulation exceeded the current 30-second budget. Decide whether to retain the cap or extend the recovery window.', createdAt: at(560) });
  add('attention.open', { id: 'schema-review', agentId: 'atlas-api', title: 'Review the pagination contract', detail: 'Confirm the public response shape before the migration is released.', createdAt: at(310) });
  add('handoff.offer', { id: 'review-release', agentId: 'relay-docs', title: 'Review the release note draft', detail: 'Check the upgrade instructions and compatibility notes.', createdAt: at(890) });
  add('handoff.offer', { id: 'index-benchmark', agentId: 'moss-index', title: 'Compare incremental index timings', detail: 'Measure the sample collection after the current rebuild completes.', createdAt: at(420) });
  add('handoff.offer', { id: 'cursor-docs', agentId: 'atlas-api', title: 'Document cursor pagination examples', detail: 'Add examples for an empty page and a final page.', createdAt: at(240) });
  add('handoff.offer', { id: 'contract-review', agentId: 'atlas-api', title: 'Check downstream API consumers', detail: 'Review optional cursor handling in the client contract checks.', createdAt: at(730) });
  add('handoff.claim', { id: 'contract-review', owner: 'atlas-tests' });
  return applyCommands(emptyState(), commands, now);
}
