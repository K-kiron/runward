# Transcript adapters

Runward polls only files explicitly supplied with `--watch`. It does not discover sessions, read credential files, change provider configuration, or attach to a running agent process. Original transcripts are never modified.

Each selected file receives a stable source identifier derived from its provider and absolute path. Its records are converted to one agent and timestamped spans. Moving the file creates a different source identity. Multiple selected files are separate agents; subagent relationships are not inferred across files.

## Recognized records

| Provider | Recognized data | Interpretation |
| --- | --- | --- |
| Claude Code | `assistant` / `user` records with `timestamp`, `sessionId`, `cwd`, `message.content` | Text and thinking blocks become instants. `tool_use` / `tool_result` pair by call ID. |
| Claude Code | `message.usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | Latest explicit input context usage; no assumed context-window size. |
| Codex | `session_meta` | Session name and working directory. |
| Codex | `response_item` with message, reasoning summary, function/custom-tool calls and outputs | Text/summary instants and matched tool spans. |
| Codex | `event_msg` task/turn started, completed, aborted, error | Explicit working/idle state and lifecycle/error instants. Completion alone is not a passed run. |
| Codex | `event_msg` token_count | Latest explicit input-token usage and model context-window limit; cumulative token spending is not presented as context usage. |

The readers follow common producer record shapes, not a version-negotiated integration. Relevant primary references are the [Codex protocol definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), [Codex message models](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs), and [Claude Code context-window fields](https://code.claude.com/docs/en/statusline#context-window-fields). Producer schemas can change; unsupported records are ignored.

## Evidence limits

- A tool duration is the difference between its invocation-record and output-record timestamps. It may include buffering or orchestration time. Thinking/message records have no measured duration and remain instants.
- An unmatched invocation remains open, which means **no result was observed**, not confirmed process activity. A result without an invocation does not create a fabricated interval.
- Claude agent state remains unknown without a supported lifecycle signal. Last-seen age is displayed separately. No model identity, money, checks, task success, handoff, or human-attention requirement is inferred from message prose.
- JSONL rows are processed in timestamp order; duplicate identical rows are ignored. Malformed rows, missing/invalid timestamps, incomplete trailing records, unmatched results, and truncation produce warnings. Good rows remain usable.
- Long detail is clipped to 12,000 characters. At most 5,000 spans and 100 individual warning messages are retained per parse, with an omitted-warning count. Unsupported control characters are shown as escaped text. Logs are not automatically scrubbed of secrets.

## Polling and persistence

Files are checked every two seconds and reparsed when file identity, size, or modification time changes. The initial and later imports use upserts, so stable IDs do not duplicate spans. Imports commit in batches of at most 1,000 commands; a very large import can appear over several state revisions.

Files larger than 32 MiB are rejected with a warning. For larger histories, send selected events through the API or make a separately labeled trimmed copy. No automatic archive discovery or recursive directory watch is performed. Previously imported records remain in bounded state when a file is removed or truncated; absence is not treated as a deletion command.

Tests use synthetic JSONL fixtures under `test/fixtures/`. They establish behavior for the represented formats and edge cases, not compatibility with every provider version or real production session.
