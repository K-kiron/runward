# Runward

A local operations desk for coding agents. See who is working, inspect parallel execution, track runs, and keep handoffs from getting lost.

The standalone Runward server runs on your machine with **Node.js 22+ and no runtime dependencies**. It serves a browser interface on loopback, stores live state locally, and makes no outbound requests. Demo data is synthetic and clearly labeled.

![Runward demo with agent activity lanes, run results, attention requests, and handoffs](docs/screenshot.png)

## Try it

```sh
git clone https://github.com/K-kiron/runward.git
cd runward
npm run demo
```

Open **http://127.0.0.1:4317** and select **Connect**. The terminal prints separate read and action tokens. Use the read token to inspect activity, or the action token to coordinate handoffs and resolve attention items. Both require authentication. An operator alias is required only for coordination; it is an entered label, not an authenticated identity. Demo changes stay in memory and reset on restart.

For an empty live domain:

```sh
npm start -- --domain personal --environment laptop
```

Live mode requires an explicit domain/environment or a config file. It persists to `~/.runward/domains/personal/laptop/state.json` in this example. Use `--data` to select another file and `--port` to change the port. Keep one process and state file per domain/environment. The old `~/.runward/state.json` is preserved and never loaded implicitly; see [migration and isolation](docs/isolation.md).

## What it does

- Project, provider, and status filters with consistent counts and freshness indicators.
- Shared-clock waterfall lanes, including overlap, idle gaps, and open spans. Click a segment to inspect its timestamp, duration, and detail.
- Console and chronological event views; run results with check counts and failure details.
- Attention items with explicit resolution, and handoffs with claim, release, and complete transitions.
- Live updates through server-sent events, with reconnect and stale-state feedback.
- Selected-file transcript import for Codex, Claude Code, DSH (DeepSeek Harness), OpenCode, OpenHands, and Gemini CLI, plus a provider-neutral event API.

Claims are coordination records. They **do not launch agents, send prompts, approve tool calls, or execute terminal commands**. Console content is read only. Provider names identify incoming data, not an affiliation.

## OpenHands Agent Canvas App

The optional [Canvas App](apps/openhands/README.md) adds a read-only Runward page inside OpenHands Agent Canvas. Install it from this repository with **Repo path `apps/openhands`** and a revision containing the app. It reads the selected conversation through Canvas's authenticated Agent Server HTTP helper; it does not require a separate Runward server or a manually entered API key.

The App targets the beta host API 1 on supported local backends. OpenHands Cloud backends are not supported. Timezone-naive events remain untimed unless you explicitly supply the server's fixed UTC offset. See the [installation, trust model, timing rules, and verification limits](apps/openhands/README.md).

## Connect actual sessions

Choose specific transcript files for one data-access domain; Runward never scans your home directory, discovers provider logins, or edits provider settings.

```sh
node cli.mjs --domain personal --environment laptop --watch "codex=/absolute/path/rollout.jsonl"
node cli.mjs --domain company --environment work-vm --port 4318 --watch "claude=/absolute/path/session.jsonl"
```

These are separate processes with separate stores and credentials. Run each in its intended environment. Different ports on one computer do not create an OS security boundary. Combine `--watch` options only for sources that may share all raw data with the same readers.

For explicit source names, identity assertions, and generation changes, save a config such as `personal.json`:

```json
{
  "domain": { "id": "personal", "environmentId": "laptop" },
  "sources": [
    {
      "id": "editor-session",
      "provider": "codex",
      "toolInstanceId": "cli-profile-a",
      "generation": 1,
      "identity": "identity-a",
      "path": "./logs/rollout.jsonl"
    }
  ]
}
```

```sh
node cli.mjs --config personal.json
```

Paths resolve relative to the config file. Identity aliases are optional, opaque operator assertions; omitted identities remain unknown. A project name, config directory, or alias does not prove which account produced a record. Runward generates file bindings itself; do not copy `fileIdentity` into a config by hand.

Selected files are polled every two seconds. While running, replacement, truncation, link retargeting, or rewriting previously read bytes pauses the source. This also affects legitimate exports rewritten in place: use a reviewed new generation. Across restarts, file identity is checked, but a same-inode content rewrite made while stopped is not detected by the process-local append guard. See [source lifecycle and limits](docs/isolation.md#source-enrollment-and-file-lifecycle).

The six readers support Codex, Claude Code, DSH, OpenCode, OpenHands, and Gemini CLI. DSH Zstandard logs require Node.js 22.15+ with Zstandard support. See [adapter coverage and capture commands](docs/adapters.md) for supported formats and timing limits.

For your own agent or runner, submit explicit events using [the event API](docs/events.md):

```sh
# Supply the enrolled source's token through RUNWARD_INGEST_TOKEN first.
node cli.mjs ingest examples/events.json
```

Read, action, and source-ingest tokens are separate capabilities. `RUNWARD_READ_TOKEN` and `RUNWARD_TOKEN` can reuse previously issued, matching read and action tokens at startup. `RUNWARD_INGEST_TOKEN` is used by the ingest command and must match an enrolled source/generation. Tokens are bound to their domain/environment and role; ingestion is additionally source-bound. Never put them in URLs, config files, commits, or screenshots.

The browser exchanges a read/action root token for a revocable session lasting at most eight hours, then forgets the root token. It keeps only that session in tab memory, with no credential cookies or browser storage. **Lock** clears loaded activity, filters, inspector content and pending responses, closes the stream, and requests session revocation.

## Data and trust

Runward binds only to `127.0.0.1`. Host and browser-origin checks reject foreign sites. All data reads, including snapshots and SSE, require bearer authorization; only the non-sensitive health response is public. A read token grants the entire domain's snapshot. Project/provider filters organize that authorized data and are not access controls.

Separate authenticated domain instances implement the P0 isolation boundary described in [issue #3](https://github.com/K-kiron/runward/issues/3). The P1 combined metadata overview has **not** shipped. There is no shared multi-domain raw-data viewer or provider credential broker. See the [isolation guide](docs/isolation.md) for deployment, token roles, explicit migration, purge, and provider scenarios.

Transcript text, tool arguments, and tool results can contain secrets. Runward does not redact or application-encrypt them. An unrestricted process running as the same OS user, an administrator, or a compromised trusted browser can still access data or credentials. Strong personal/company isolation needs enforced OS-user, sandbox, or VM boundaries and appropriate file permissions. Runward does not automatically change Windows ACLs. It makes no outbound requests, uses no telemetry, CDN, external fonts, or hosted API, and should not be exposed through a public tunnel.

State writes are serialized and replaced atomically after flushing the temporary file. A canonical state-file lock prevents concurrent writers. Invalid batches do not partially apply; corrupt, mismatched, or unmigrated legacy state stops startup instead of being overwritten. Persisted domain stores are limited to 8 MiB, with bounded record retention. Removing a watcher does not delete history: use an explicit [source purge](docs/isolation.md#purge-and-retention). Original transcripts and backups remain outside that purge.

## Scope and provenance

This is an independent implementation based on the visible feature set in two screenshots of an agent dashboard. Its layout, code, example data, and event protocol are original. No original executable, web application, source code, or traffic capture was available. Screenshot analysis establishes visible features only; it does not establish internal behavior or protocol compatibility. Runward does not claim compatibility with that dashboard.

Transcript adapters are best-effort readers of documented/common record shapes. Completed-item timings use explicit producer timestamps; older formats fall back to log-record boundaries. Missing metrics remain unknown. A finished conversation is not automatically a passed verification run. See [adapter coverage and upgrade notes](docs/adapters.md) before reimporting state created by version 0.1.0.

## Development

```sh
npm test
npm run check
```

Tests cover state validation, domain/source namespaces, token roles, browser session races and revocation, migration and purge, file enrollment, concurrent claims, persistence failures, streaming, and synthetic transcript parsing. The CI matrix runs on Windows and Linux with Node.js 22 and 24. Synthetic isolation tests do not certify provider login behavior or a deployed machine's OS permissions.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
