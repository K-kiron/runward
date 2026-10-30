# Contributing

Use Node.js 22 or newer. No dependency installation or build step is required.

Run `npm run check` before submitting changes. Add focused tests when changing event validation, coordination transitions, transcript parsing, source enrollment, authorization, or persistence. Keep fixtures synthetic; never commit real agent transcripts, access tokens, private paths, or conversation screenshots.

- `lib/model.mjs`: validated state transitions and retention.
- `lib/domain.mjs`: source enrollment, producer-ID namespaces, version-2 stores, explicit migration and purge tombstones.
- `lib/adapters.mjs`: pure transcript conversion.
- `lib/enrollment.mjs`: canonical file enrollment and guarded append-only reads.
- `lib/watch.mjs`: explicit-file polling.
- `server.mjs`: local HTTP, authorization, streaming, and durable writes.
- `cli.mjs`: domain configuration, source-bound ingest, migration and purge commands.
- `public/`: browser interface with no external dependencies.
- `apps/openhands/src/`: read-only Agent Canvas App using the shared OpenHands reader.

After changing the Canvas sources or their shared reader, run `npm run build:canvas` to regenerate `apps/openhands/extension.js`. Commit the self-contained bundle with its sources so Git-based Canvas installation works without a build step. `npm run check` rejects a stale bundle. The standalone server still needs no build or dependency installation.

Keep provider-specific parsing out of the UI. Preserve unknown values instead of inventing success, utilization, or durations. A handoff claim assigns ownership and must not silently execute work. Public interface and documentation use English.

For a parser bug, include a minimal synthetic record that reproduces it and identify the producer version when known. For a UI change, check keyboard operation, narrow screens, empty data, disconnection, and untrusted text rendering.

Read the [domain isolation contract](docs/isolation.md) and [event API](docs/events.md) before changing security boundaries. Live CLI examples must include `--domain` and `--environment`, or `--config`. Source ingestion uses `RUNWARD_INGEST_TOKEN`; action capabilities use `RUNWARD_TOKEN`; read capabilities use `RUNWARD_READ_TOKEN`. The browser exchanges read/action root capabilities for memory-only derived sessions. Keep payload fields and UI filters out of authorization decisions, and preserve unknown or operator-asserted provider identity rather than inferring it from a path or login.

Security regressions should cover cross-domain/source rejection, read/action/ingest separation, locked and expired browser sessions, stale asynchronous responses, store locking, explicit legacy selection, and purge replay rejection where relevant. File tests must cover replacement and append-only enforcement without reading actual sessions. A legitimate export rewrite also requires a reviewed new generation; the current byte-prefix guard is process-local and does not detect offline same-inode changes. Tests must not claim OS account isolation or real provider authentication coverage from synthetic fixtures.
