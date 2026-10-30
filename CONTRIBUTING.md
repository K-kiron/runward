# Contributing

Use Node.js 22 or newer. No dependency installation or build step is required.

Run `npm run check` before submitting changes. Add focused tests when changing event validation, coordination transitions, transcript parsing, or persistence. Keep fixtures synthetic; never commit real agent transcripts, access tokens, private paths, or conversation screenshots.

- `lib/model.mjs`: validated state transitions and retention.
- `lib/adapters.mjs`: pure transcript conversion.
- `lib/watch.mjs`: explicit-file polling.
- `server.mjs`: local HTTP, authorization, streaming, and durable writes.
- `public/`: browser interface with no external dependencies.
- `apps/openhands/src/`: read-only Agent Canvas App using the shared OpenHands reader.

After changing the Canvas sources or their shared reader, run `npm run build:canvas` to regenerate `apps/openhands/extension.js`. Commit the self-contained bundle with its sources so Git-based Canvas installation works without a build step. `npm run check` rejects a stale bundle. The standalone server still needs no build or dependency installation.

Keep provider-specific parsing out of the UI. Preserve unknown values instead of inventing success, utilization, or durations. A handoff claim assigns ownership and must not silently execute work. Public interface and documentation use English.

For a parser bug, include a minimal synthetic record that reproduces it and identify the producer version when known. For a UI change, check keyboard operation, narrow screens, empty data, disconnection, and untrusted text rendering.
