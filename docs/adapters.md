# Transcript adapters

Runward polls only files explicitly supplied with `--watch`. It does not discover sessions, read credential files, change provider configuration, or attach to a running agent process. Original transcripts are never modified.

Each selected file receives a stable source identifier derived from its provider and absolute path. Its records are converted to one agent and timestamped spans. Moving the file creates a different source identity. Multiple selected files are separate agents; subagent relationships are not inferred across files. Provider names identify the development tool that wrote a recording, independently of which model it used.

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

All examples run from the Runward repository. Replace paths and session IDs with your own. Capturing a new agent run can execute its normal tools and use its configured model; Runward's file reader does neither. Watch the recording in another terminal while the producer appends to it.

### DSH (DeepSeek Harness)

Select the current `session.v4.jsonl.zstd` (or uncompressed `.jsonl`) in the session directory under `~/.dsh/sessions/`. The adapter supports format 4 from DSH `0.2.2-alpha.2`; older or newer session formats are reported as unsupported. A session-log ZIP export must first be extracted; select its root `session.v4.jsonl` rather than the ZIP. Select each sub-session log separately. Runward reads concatenated Zstandard frames without changing DSH's compression settings or modifying the source file.

The reader recognizes the format-4 header and sequenced events, compact assistant-stream fragments, explicit tool call/result pairs, and seed-history boundaries. A seeded log is deferred until its tagged boundary arrives; inherited history is excluded. A sequence gap stops the unverified suffix. Generated tool arguments alone do not establish that the tool executed.

```sh
node cli.mjs --watch "dsh=/absolute/path/session.v4.jsonl.zstd"
```

### OpenCode

Export one session as JSON, then watch that export. For newer v2 installations, use `opencode session export SESSION_ID > session.json`; v1 installations use `opencode export SESSION_ID > session.json`. An export is a snapshot: export again to update the file.

For an ongoing run, capture its JSON output instead. Reasoning output needs `--thinking` where supported:

```sh
opencode run --format json --thinking "YOUR TASK" > opencode-events.jsonl
node cli.mjs --watch "opencode=/absolute/path/opencode-events.jsonl"
```

Both v1 nested message/part exports and v2 flat-message exports are supported. Current v2 exports omit unsettled assistant messages upstream; use the live JSONL capture to observe those. Explicit tool part times are preserved; missing timing becomes an observation instant. A completed step is not proof that the whole session is idle or that verification passed.

### OpenHands

Use the headless CLI JSON callback stream. OpenHands headless mode auto-approves its normal agent actions; run it only with a task and workspace you intend it to operate on. The supplied helper preserves the producer's original timestamp and adds `runwardObservedAt` as an explicit UTC receipt time, so recordings with timezone-naive timestamps can still be imported:

```sh
openhands --headless --json -t "YOUR TASK" | node examples/capture-openhands.mjs > openhands-events.jsonl
node cli.mjs --watch "openhands=/absolute/path/openhands-events.jsonl"
```

Offset-bearing producer timestamps take precedence. When only receipt timestamps are available, intervals describe when events were observed. Existing timezone-naive logs without a capture time are skipped with a warning; Runward does not guess their timezone. SDK event JSON files can also be selected individually. Native SDK event directories and ZIP files are not watched recursively.

### Gemini CLI

Select a `session-*.jsonl` chat recording under `~/.gemini/tmp/<project>/chats/`; older `session-*.json` conversation snapshots are also accepted. No model call or configuration change is needed to read an existing recording.

```sh
node cli.mjs --watch "gemini=/absolute/path/session-example.jsonl"
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

Files are checked every two seconds and reparsed when file identity, size, or modification time changes. Only new or changed commands are dispatched; unsupported or incomplete appended rows do not rewrite unchanged history. Successfully committed batches are acknowledged individually so a retry does not replay them. Imports commit in batches of at most 1,000 commands; a very large import can appear over several state revisions.

UTF-8 recordings and BOM-marked UTF-16 exports from Windows shell redirection are supported. Runward decodes in memory and preserves the original file encoding.

Files larger than 32 MiB are rejected with a warning. Compressed inputs also have a 32 MiB decompressed limit and a 100,000-frame limit. Zstandard requires Node.js 22.15+ with native Zstandard support. A partial compressed frame is retried without overwriting previously imported state. For larger histories, send selected events through the API or make a separately labeled trimmed copy. No automatic archive discovery or recursive directory watch is performed. Previously imported records remain in bounded state when a file is removed, truncated, or rewound by the producer; absence is not treated as a deletion command. Use a fresh state file to rebuild only the producer's current visible history.

## Upgrading an existing import

The completed-item reader uses a unified identity for Codex response and completed-item records. If you imported Codex logs with version 0.1.0, retain the old state as a backup and select a **new state file** with `--data` when reimporting. This avoids retaining old event IDs or inherited parent-history records alongside the corrected events. Runward does not delete old state automatically. Manually created runs, handoffs, and attention items remain in the old state file and are not copied to the new one.

Parser coverage was checked locally against sessions written by Codex `0.163.0-alpha.10.2`, including forked agents and an actively appended conversation. Public tests use synthetic records under `test/`; no real transcripts are distributed. This does not establish compatibility with every producer version. Claude coverage remains based on synthetic fixtures.

The additional adapters use synthetic recordings based on official producer schemas. They have not been validated against real model-backed runs. Gemini coverage follows [chat-recording types](https://github.com/google-gemini/gemini-cli/blob/b633c0703417eff3f6db8b684515e2b26a824e82/packages/core/src/services/chatRecordingTypes.ts) and [record folding](https://github.com/google-gemini/gemini-cli/blob/b633c0703417eff3f6db8b684515e2b26a824e82/packages/core/src/services/chatRecordingService.ts). Malformed and unsupported records do not establish successful work.

Additional schema references checked for this release:

- DSH [`SessionEvent` and format version](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/session/src/types.ts), [compact stream codec](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-format-v1-to-v2/src/codec.ts), and [session-log export](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session-query/session-log-export/README.md).
- OpenCode [v1.19.4 exports](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/cli/cmd/export.ts), [v2 messages](https://github.com/anomalyco/opencode/blob/17f4634afedb38d72f29b4f5954b4c2250735c5c/packages/schema/src/session-message.ts), and [JSONL output](https://github.com/anomalyco/opencode/blob/17f4634afedb38d72f29b4f5954b4c2250735c5c/packages/cli/src/run/noninteractive.ts).
- OpenHands [CLI JSON callback](https://github.com/OpenHands/OpenHands-CLI/blob/283c6ac3610f4299f405f7389f65766dcb83e12a/openhands_cli/utils.py), [event timestamps](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-sdk/openhands/sdk/event/base.py), and [action/observation schema](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-sdk/openhands/sdk/event/llm_convertible/observation.py). Legacy OpenHands event formats and `base_state.json` configuration snapshots are not supported.
