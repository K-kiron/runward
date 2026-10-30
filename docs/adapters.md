# Transcript adapters

Runward polls only files explicitly supplied with `--watch` or a source `path` in `--config`. Live mode requires a domain and environment. It does not discover sessions, read credential files, change provider configuration, or attach to a running agent process. Original transcripts are never modified. See [domain isolation and enrollment](isolation.md#explicit-source-configuration) before combining personal and company recordings.

The `--watch` shorthand derives stable source/tool-instance identifiers from the provider and normalized selected path, uses generation 1, and records provider identity as unknown. The canonical target and file identity are persisted as the binding, so retargeting the same selected link cannot create a new source implicitly. Use `--config` for explicit source names, tool-instance labels, optional operator-asserted identity aliases, and reviewed generation changes. Its paths resolve relative to the config file. Changing an existing enrollment requires a new generation.

Records are converted to one agent and timestamped spans per selected file, then namespaced by domain, environment, source and generation. Multiple selected files are separate agents; subagent relationships are not inferred across files. Provider names identify the development tool that wrote a recording, independently of which model it used. A current login, path, or project label does not establish historical account ownership.

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
| DSH (DeepSeek Harness) | Session JSONL and Zstandard logs | Session metadata, recorded lifecycle, messages, reasoning, and paired tool calls/results. |
| OpenCode | Session export JSON and `run --format json` JSONL | Message/part IDs, text, reasoning, explicit tool state and time, errors, and subtask activity. |
| OpenHands | CLI headless JSONL and SDK event JSON | Messages, action/observation pairs, and explicit agent errors. Timezone-naive records require an explicit capture timestamp. |
| Gemini CLI | Chat-recording JSONL and older conversation JSON | Latest message snapshots, metadata updates, patches, rewinds, thought summaries, and scoped tool IDs. |

The readers follow common producer record shapes, not a version-negotiated integration. Relevant primary references are the [Codex protocol definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), [Codex message models](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs), and [Claude Code context-window fields](https://code.claude.com/docs/en/statusline#context-window-fields). Producer schemas can change; unsupported records are ignored.

## Select or capture a recording

All examples run from the Runward repository. Replace domains, environments, paths and session IDs with reviewed values for your installation. Capturing a new agent run can execute its normal tools and use its configured model; Runward's file reader does neither. Create the recording before enrollment, then watch it in another terminal while the producer appends to it. A later rewrite or replacement requires explicit reenrollment, even for a supported export format.

### DSH (DeepSeek Harness)

Select the current `session.v4.jsonl.zstd` (or uncompressed `.jsonl`) in the session directory under `~/.dsh/sessions/`. The adapter supports format 4 from DSH `0.2.2-alpha.2`; older or newer session formats are reported as unsupported. A session-log ZIP export must first be extracted; select its root `session.v4.jsonl` rather than the ZIP. Select each sub-session log separately. Runward reads concatenated Zstandard frames without changing DSH's compression settings or modifying the source file.

The reader recognizes the format-4 header and sequenced events, compact assistant-stream fragments, explicit tool call/result pairs, and seed-history boundaries. A seeded log is deferred until its tagged boundary arrives; inherited history is excluded. A sequence gap stops the unverified suffix. Generated tool arguments alone do not establish that the tool executed.

```sh
node cli.mjs --domain personal --environment laptop --watch "dsh=/absolute/path/session.v4.jsonl.zstd"
```

### OpenCode

Export one session as JSON, then watch that unchanged export. For newer v2 installations, use `opencode session export SESSION_ID > session.json`; v1 installations use `opencode export SESSION_ID > session.json`. An export is a snapshot. To refresh it, produce and review a new export, then select it under a new source generation in `--config`; overwriting an enrolled export does not provide an append-only update stream.

For an ongoing run, capture its JSON output instead. Reasoning output needs `--thinking` where supported:

```sh
opencode run --format json --thinking "YOUR TASK" > opencode-events.jsonl
node cli.mjs --domain personal --environment laptop --watch "opencode=/absolute/path/opencode-events.jsonl"
```

Both v1 nested message/part exports and v2 flat-message exports are supported. Current v2 exports omit unsettled assistant messages upstream; use the live JSONL capture to observe those. Explicit tool part times are preserved; missing timing becomes an observation instant. A completed step is not proof that the whole session is idle or that verification passed.

### OpenHands

Use the headless CLI JSON callback stream. OpenHands headless mode auto-approves its normal agent actions; run it only with a task and workspace you intend it to operate on. The supplied helper preserves the producer's original timestamp and adds `runwardObservedAt` as an explicit UTC receipt time, so recordings with timezone-naive timestamps can still be imported:

```sh
openhands --headless --json -t "YOUR TASK" | node examples/capture-openhands.mjs > openhands-events.jsonl
node cli.mjs --domain personal --environment laptop --watch "openhands=/absolute/path/openhands-events.jsonl"
```

Offset-bearing producer timestamps take precedence. When only receipt timestamps are available, intervals describe when events were observed. Existing timezone-naive logs without a capture time are skipped with a warning; Runward does not guess their timezone. SDK event JSON files can also be selected individually. Native SDK event directories and ZIP files are not watched recursively.

### Gemini CLI

Select a `session-*.jsonl` chat recording under `~/.gemini/tmp/<project>/chats/`; older `session-*.json` conversation snapshots are also accepted. No model call or configuration change is needed to read an existing recording.

```sh
node cli.mjs --domain personal --environment laptop --watch "gemini=/absolute/path/session-example.jsonl"
```

Gemini's append-only message replacements, `$set`, `$patch`, and `$rewindTo` are folded in file order before conversion. Tool IDs are scoped to their message, because call IDs can be reused in later turns. Thought summaries remain instants; a snapshot with only one tool timestamp does not establish a duration. Session completion and verification success are not inferred from a final assistant message.

## Evidence limits

- Completed items use valid `started_at_ms` / `completed_at_ms` values reported by the producer. A matching response record and completed item share one identity, even when completion is logged first. Explicit failures, nonzero exit codes, and tool error flags are retained; message prose never establishes success or failure.
- Without completed-item timing, tool durations use invocation/output record timestamps and thinking/message records remain instants. These fallback intervals may include buffering or orchestration time. Encrypted reasoning is never decoded; a timed reasoning event can have no readable summary.
- Native tool events and their outer orchestration calls may have different IDs and overlapping times. They remain separate observations; Runward does not guess a parent-child relationship or add their durations together.
- An unmatched invocation remains open, which means **no result was observed**, not confirmed process activity. A result without an invocation does not create a fabricated interval.
- Claude agent state remains unknown without a supported lifecycle signal. Last-seen age is displayed separately. No model identity, money, checks, task success, handoff, or human-attention requirement is inferred from message prose.
- Timeline spans are sorted by timestamp. Log folding follows each producer's record order and identity rules, including message replacement and explicit sequence boundaries. Malformed rows, missing/invalid timestamps, incomplete trailing records, unmatched results, and truncation produce warnings. Usable records remain importable within those boundaries.
- Long detail is clipped to 12,000 characters. At most 5,000 spans and 100 individual warning messages are retained per parse, with an omitted-warning count. Unsupported control characters are shown as escaped text. Logs are not automatically scrubbed of secrets.

## Polling and persistence

Files are checked every two seconds using pathname/link, canonical-path and open-file identity checks before and after reading. Previously read bytes must remain unchanged: replacement, symlink/junction retargeting, disappearance, truncation, or an earlier-byte rewrite pauses the source until reviewed reenrollment with a new generation. Normal append growth is allowed. Content fingerprints avoid reparsing unchanged bytes; only new or changed commands are dispatched. Unsupported or incomplete appended rows do not rewrite unchanged history. Successfully committed batches are acknowledged individually so a retry does not replay them. Imports commit in batches of at most 1,000 commands; a very large import can appear over several state revisions.

The guard applies to legitimate producer changes too. JSON exports or conversation snapshots that are rewritten or atomically replaced require a reviewed new generation; parser support does not promise append-only producer behavior. Repeated source generations preserve their separate history until purged. The byte-prefix hash is process-local: an offline same-inode rewrite while Runward is stopped is not detected on restart. Persisted file identity detects replacement, but does not authenticate content or account identity. See [file lifecycle and limitations](isolation.md#source-enrollment-and-file-lifecycle).

UTF-8 recordings and BOM-marked UTF-16 exports from Windows shell redirection are supported. Runward decodes in memory and preserves the original file encoding.

Files larger than 32 MiB are rejected; an oversized file selected at startup cannot be enrolled. Compressed inputs also have a 32 MiB decompressed limit and a 100,000-frame limit. Zstandard requires Node.js 22.15+ with native Zstandard support. A partial compressed frame is retried without overwriting previously imported state. For larger histories, send selected events through a source-bound [ingest capability](events.md), or make a separately labeled trimmed copy and enroll it explicitly. No automatic archive discovery or recursive directory watch is performed.

Previously imported records remain in the domain store when collection stops, a file disappears, or an append-only producer record rewinds its visible history; absence is not a deletion command. The store has fixed record limits and an 8 MiB size limit. Use an action capability to [purge a source](isolation.md#purge-and-retention) when its stored history must be removed. Purge revokes all enrolled generations for that source, rejects their replay, and leaves original transcripts and backups untouched. Removing a source from config only stops collection after restart.

## Upgrading an existing import

Existing version-1 stores require [explicit migration](isolation.md#legacy-migration) of reviewed agent IDs into a fresh domain store, or a fresh reimport of selected recordings. The old default state is not opened automatically. Migration preserves selected historical content and does not repair parser decisions in that history.

The completed-item reader uses a unified identity for Codex response and completed-item records. For imports originally created by Runward 0.1.0, retain the old store as a backup and reimport reviewed logs into a **new state file** with `--data`, plus `--domain` and `--environment` or `--config`. This avoids retaining old event IDs or inherited parent-history records alongside corrected events. Runward does not delete old state automatically. Manually created runs, handoffs, and attention items remain in the old store unless explicitly selected through migration.

Parser coverage was checked locally against sessions written by Codex `0.163.0-alpha.10.2`, including forked agents and an actively appended conversation. Public tests use synthetic records under `test/`; no real transcripts are distributed. This does not establish compatibility with every producer version. Claude coverage remains based on synthetic fixtures.

The additional adapters use synthetic recordings based on official producer schemas. They have not been validated against real model-backed runs. Gemini coverage follows [chat-recording types](https://github.com/google-gemini/gemini-cli/blob/b633c0703417eff3f6db8b684515e2b26a824e82/packages/core/src/services/chatRecordingTypes.ts) and [record folding](https://github.com/google-gemini/gemini-cli/blob/b633c0703417eff3f6db8b684515e2b26a824e82/packages/core/src/services/chatRecordingService.ts). Malformed and unsupported records do not establish successful work.

Additional schema references checked for this release:

- DSH [`SessionEvent` and format version](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/session/src/types.ts), [compact stream codec](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-format-v1-to-v2/src/codec.ts), and [session-log export](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session-query/session-log-export/README.md).
- OpenCode [v1.19.4 exports](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/cli/cmd/export.ts), [v2 messages](https://github.com/anomalyco/opencode/blob/17f4634afedb38d72f29b4f5954b4c2250735c5c/packages/schema/src/session-message.ts), and [JSONL output](https://github.com/anomalyco/opencode/blob/17f4634afedb38d72f29b4f5954b4c2250735c5c/packages/cli/src/run/noninteractive.ts).
- OpenHands [CLI JSON callback](https://github.com/OpenHands/OpenHands-CLI/blob/283c6ac3610f4299f405f7389f65766dcb83e12a/openhands_cli/utils.py), [event timestamps](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-sdk/openhands/sdk/event/base.py), and [action/observation schema](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-sdk/openhands/sdk/event/llm_convertible/observation.py). Legacy OpenHands event formats and `base_state.json` configuration snapshots are not supported.
