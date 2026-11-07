# Desktop session collection

The desktop collector observes multiple Codex and Claude Code sessions using explicit transcript directories and workspace scopes. Start it separately from the regular selected-file server:

```sh
npm run desktop -- --config /path/to/desktop.json
```

The collector uses the existing authenticated loopback server and dashboard. Startup prints read and action capabilities; enter the read capability in the dashboard to inspect activity. Capabilities stay in runtime credentials and must not be put in config files or URLs. Activity is held in memory and is reconstructed from recent transcripts on restart. This command does not start agents, authenticate provider accounts, or edit original logs.

## Explicit configuration

Save your config outside the repository. All paths resolve relative to that config file. For Codex, select both a transcript directory and the workspace roots allowed into this data domain:

```json
{
  "domain": { "id": "personal", "environmentId": "desktop" },
  "port": 4317,
  "codexSessionsRoot": "./provider-data/sessions",
  "codexScopeRoots": ["./workspaces"],
  "codexIndexPath": "./provider-data/session_index.jsonl"
}
```

Replace the example paths with your local transcript and workspace directories. `codexIndexPath` is optional; discovery otherwise checks `session_index.jsonl` beside the selected sessions directory. `codexTranscript` can additionally pin an explicitly selected file, or can be used alone without directory discovery. Each distinct log path produces a separate session identity. A pinned file that is also discovered is imported once.

For Claude Code, configure `claudeScopeRoot` and `claudeProjectsRoot` together:

```json
{
  "domain": { "id": "company", "environmentId": "desktop" },
  "port": 4318,
  "claudeScopeRoot": "./workspaces",
  "claudeProjectsRoot": "./provider-data/projects",
  "claudeRegistryRoot": "./provider-data/desktop-session-registry",
  "claudeRepoRoot": "./workspaces/app"
}
```

The optional registry supplies saved desktop titles and CLI session associations. The optional repository supplies registered Git worktrees through the local `git worktree list` command. Without those fields, discovery only considers project directories matching the explicit scope. Registry metadata cannot override an explicitly out-of-scope working directory. Unregistered nested CLI project directories are not recursively inferred from their encoded names.

Both provider configurations may be combined only when their activity may be shared with every reader of the same domain. Workspace filters are not account authentication or OS isolation. Use separate configs, domains and processes when readers differ; see [domain isolation](isolation.md).

## Activity and lifecycle

Discovery runs every ten seconds and selected logs are polled every two seconds by default. New main sessions appear without restarting. Codex subagent logs are excluded from desktop session discovery. A main session's subagent tool events can still appear in its own timeline.

File size changes trigger another read even if Windows has not refreshed an open file's modification time. Inactivity is decided from producer event timestamps, rather than modification time or a title change. Old Claude files receive a bounded tail check; unchanged checks reuse a bounded metadata cache, and appended bytes invalidate it. A recent index update can nominate a Codex candidate but does not manufacture recent activity in the dashboard.

Claude records must match the selected session and an allowed working directory. Later rows may omit `cwd` and inherit a previously verified directory or scoped discovery metadata. An explicit foreign directory revokes that inherited scope until an allowed directory is reported again.

Working status follows explicit lifecycle evidence from the shared adapters. Missing evidence remains unknown. The dashboard still marks evidence older than two minutes stale and defaults to a five-minute activity window. An operating-system window, unmatched tool call, or file modification alone does not prove that an agent is currently executing.

## Bounds and source lifecycle

Each provider returns at most 100 discovered sessions. Codex enumerates only the expected year/month/day log layout, with limits of 40,000 directory entries and 2,000 inspected files; headers are limited to 64 KiB and discovery tails to 64 KiB. The optional index read is limited to 8 MiB. Claude's old-file freshness checks read at most 256 KiB per candidate and retain at most 4,096 metadata cache entries. Discovery limits and per-file errors are available through the returned collector's `status()` method when embedding the module.

Codex collection reads a selected file up to 32 MiB. Claude collection reads the latest 4 MiB by default and discards incomplete boundary records. Each read imports up to 100 recent spans per session, with details shortened to 400 characters and marked as shortened. Older history, tool calls split across the tail boundary, and oversized individual records can be incomplete. Global dashboard retention still applies.

The collector binds files to their canonical identity and pauses on replacement, truncation, or changes to the previously read final 64 KiB. This is a tail guard, not a full-file integrity check: edits outside that guard and offline same-inode rewrites are not excluded. A paused file remains paused for the process lifetime; review it before restarting. A purged provider source remains revoked until the process is restarted; restarting this memory-only collector deliberately reconstructs recent history from the configured files.

Provider groups are enrolled as `desktop-codex` and `desktop-claude`. Purging one of these source IDs removes and revokes all sessions in that provider group for this process. The regular persisted selected-file CLI retains its separate enrollment-generation and purge-tombstone semantics.

Optional numeric config fields are `pollIntervalMs`, `discoveryIntervalMs`, `recentHours`, `maxSessionAgeMinutes`, `tailBytes`, `eventsPerSession`, and `detailChars`. Defaults are 2,000 ms, 10,000 ms, 24 hours for discovery, 60 minutes of import activity, 4 MiB, 100 spans, and 400 characters. The dashboard's own time-window selection is independent of the import horizon.
