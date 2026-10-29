# Transcript adapters

Runward polls only files explicitly supplied with `--watch`. It does not discover sessions, read credential files, change provider configuration, or attach to a running agent process. Original transcripts are never modified.

Each selected file receives a stable source identifier derived from its provider and absolute path. Its records are converted to one agent and timestamped spans. Moving the file creates a different source identity. Multiple selected files are separate agents; subagent relationships are not inferred across files.

## Recognized records

| Provider | Recognized data | Interpretation |
| --- | --- | --- |
| Claude Code | `assistant` / `user` records with `timestamp`, `sessionId`, `cwd`, `message.content` | Text and thinking blocks become instants. `tool_use` / `tool_result` pair by call ID. |
| Claude Code | `message.usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | Latest explicit input context usage; no assumed context-window size. |
| Codex | `session_meta` | The first session identity and working directory. An explicit fork-history boundary excludes inherited parent records. |
| Codex | `response_item` with message, reasoning summary, function/custom-tool calls and outputs | Text/summary instants and matched tool spans. |
| Codex | `event_msg` task/turn started, completed, aborted, error | Explicit working/idle state and lifecycle/error instants. Completion alone is not a passed run. |
| Codex | `event_msg` token_count | Latest explicit input-token usage and model context-window limit; cumulative token spending is not presented as context usage. |
| Codex | `event_msg` item_completed | Reported reasoning, assistant-message, tool, file-change, subagent-activity, and compaction events, with explicit completion timings and failure signals. |

The readers follow common producer record shapes, not a version-negotiated integration. Relevant primary references are the [Codex protocol definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), [Codex message models](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs), and [Claude Code context-window fields](https://code.claude.com/docs/en/statusline#context-window-fields). Producer schemas can change; unsupported records are ignored.

## Evidence limits

- Completed items use valid `started_at_ms` / `completed_at_ms` values reported by the producer. A matching response record and completed item share one identity, even when completion is logged first. Explicit failures, nonzero exit codes, and tool error flags are retained; message prose never establishes success or failure.
- Without completed-item timing, tool durations use invocation/output record timestamps and thinking/message records remain instants. These fallback intervals may include buffering or orchestration time. Encrypted reasoning is never decoded; a timed reasoning event can have no readable summary.
- Native tool events and their outer orchestration calls may have different IDs and overlapping times. They remain separate observations; Runward does not guess a parent-child relationship or add their durations together.
- An unmatched invocation remains open, which means **no result was observed**, not confirmed process activity. A result without an invocation does not create a fabricated interval.
- Claude agent state remains unknown without a supported lifecycle signal. Last-seen age is displayed separately. No model identity, money, checks, task success, handoff, or human-attention requirement is inferred from message prose.
- JSONL rows are processed in timestamp order; duplicate identical rows are ignored. Malformed rows, missing/invalid timestamps, incomplete trailing records, unmatched results, and truncation produce warnings. Good rows remain usable.
- Long detail is clipped to 12,000 characters. At most 5,000 spans and 100 individual warning messages are retained per parse, with an omitted-warning count. Unsupported control characters are shown as escaped text. Logs are not automatically scrubbed of secrets.

## Polling and persistence

Files are checked every two seconds and reparsed when file identity, size, or modification time changes. Only new or changed commands are dispatched; unsupported or incomplete appended rows do not rewrite unchanged history. Successfully committed batches are acknowledged individually so a retry does not replay them. Imports commit in batches of at most 1,000 commands; a very large import can appear over several state revisions.

Files larger than 32 MiB are rejected with a warning. For larger histories, send selected events through the API or make a separately labeled trimmed copy. No automatic archive discovery or recursive directory watch is performed. Previously imported records remain in bounded state when a file is removed or truncated; absence is not treated as a deletion command.

## Upgrading an existing import

The completed-item reader uses a unified identity for Codex response and completed-item records. If you imported Codex logs with version 0.1.0, retain the old state as a backup and select a **new state file** with `--data` when reimporting. This avoids retaining old event IDs or inherited parent-history records alongside the corrected events. Runward does not delete old state automatically. Manually created runs, handoffs, and attention items remain in the old state file and are not copied to the new one.

Parser coverage was checked locally against sessions written by Codex `0.163.0-alpha.10.2`, including forked agents and an actively appended conversation. Public tests use synthetic records under `test/`; no real transcripts are distributed. This does not establish compatibility with every producer version. Claude coverage remains based on synthetic fixtures.
