# Runward for OpenHands Agent Canvas

A read-only Canvas App for inspecting recorded OpenHands conversation activity. It lives in the Runward repository so the standalone importer and Canvas App share the same OpenHands event reader and timestamp validation.

The App is a separate installable directory, not a separate repository. Its committed `extension.js` is a self-contained browser ES module; installing it does not run npm, install dependencies, or start a Runward server.

## Install

Use Agent Canvas with a supported **local Agent Server backend** exposing the Canvas Extensions API. The current Apps beta is unavailable with an OpenHands Cloud backend.

1. Open **Customize > Apps > Add app**.
2. Fill in the install form:
   - **App source**: `github:K-kiron/runward`
   - **Path** (called **Repo path** in some versions): `apps/openhands`
   - **Ref**: a reviewed branch, tag, or commit containing this directory. The App is available on `main`; use a reviewed tag or commit for a repeatable installation.
3. Select **Install**, review the App's resolved revision and manifest, then enable it after reviewing the trusted-code notice.
4. Open **Runward timeline** (or **Runward**, depending on the host's label) in the Canvas sidebar and select a conversation.

These form labels match Agent Canvas 1.34.0. For a local checkout, enter the absolute path to this directory on the **Agent Server machine** in **App source**, leaving **Ref** and **Path** empty. A browser-machine path is insufficient when the server runs elsewhere.

See the upstream [Apps installation and trust documentation](https://docs.openhands.dev/openhands/usage/agent-canvas/canvas-extensions).

## Inspect activity

- Select a conversation to read its recorded events. A shared-clock waterfall pairs action and observation records; select a span to inspect its details.
- Refresh manually, or explicitly enable automatic refresh. Automatic refresh starts disabled, never overlaps its own requests, and stops when the page is disposed.
- Unmatched observations are instants. Unmatched actions have no observed result; an open span does not prove a process is still running.
- Explicit errors remain errors. A finished conversation is not a passed test run. No cost, context utilization, success result, or cross-conversation subagent relationship is inferred.

### Timezone-naive events

Current SDK event timestamps can contain server-local wall time with **no UTC offset**. Runward does not interpret them in your browser's timezone or silently assume UTC.

By default, those records appear as untimed metadata with their raw timestamp, kind, and tool label. They do not acquire invented waterfall coordinates or durations. To include them in the waterfall, enter a known server UTC offset such as `+00:00` or `-04:00` and explicitly apply it. This affects the current page's interpretation only; original events and server configuration are unchanged.

Converted times are labeled as using a **user-supplied fixed offset**. Verify that offset for the history being inspected: daylight-saving transitions and historical offset changes are not resolved automatically. Existing timezone-bearing timestamps take precedence. Offset selection is discarded when the page is disposed or its backend changes.

## Data and trust

This implementation makes authenticated **GET requests only**, through `host.agentServer.request`:

- `/api/conversations/search?limit=100&sort_order=CREATED_AT_DESC`
- `/api/conversations/{id}/events/search?limit=100&sort_order=TIMESTAMP_DESC`

Pagination uses the returned opaque `next_page_id` as `page_id`. The picker loads at most 500 recent conversations; an inspection loads at most 2,000 newest event records. Truncated history is reported, and a paired action outside that window is not fabricated. Text details are bounded, malformed pages fail with a visible error, and parser warnings are displayed. Unsupported event kinds do not create timeline spans; the source event count may include them.

The App does not create conversations, send messages, run agents, approve tools, write files, collect telemetry, persist session history, or read credentials from Canvas internals. It sends no requests to analytics or third-party services. It renders untrusted content as text and keeps its interface and styles inside the supplied page container.

**Read-only describes this App's behavior, not a fine-grained host permission.** The current Canvas Apps beta runs trusted JavaScript with Canvas's browser authority. Review the source and resolved revision before enabling it. Imported content is not automatically redacted; do not share private conversation details in public reports.

The host helper currently has no public cancellation signal. An in-flight request can finish after disposal, but its result is ignored and subsequent pagination or refresh stops. No direct Agent Server WebSocket, backend origin discovery, or custom authentication handling is used.

## Development

From the Runward repository root:

```sh
npm run build:canvas
npm run check
```

The build script assembles a fixed set of dependency-free modules into the installable ESM entrypoint. Commit the regenerated `extension.js` with its sources. The check command verifies that the bundle matches those sources.

- `src/entry.mjs`: host API 1 page registration.
- `src/client.mjs`: bounded authenticated HTTP history reads and explicit timestamp interpretation.
- `src/view.mjs` and `src/style.mjs`: page rendering and cleanup.
- `../../lib/providers/openhands.mjs`: shared event interpretation.
- `../../lib/timestamp.mjs`: shared strict date and timezone validation.
- `../../test/canvas.test.mjs`: package, pagination, timing, malformed-response, and disposal regressions.

## Compatibility and verification

The implementation follows manifest schema 1 and host API 1. Those APIs are beta and may change. Unsupported hosts fail with a visible compatibility error; older servers may reject the history routes.

The installed App was tested in the real **Agent Canvas 1.34.0** frontend, running from its released tag in frontend-only mode with mocks disabled, against official Agent Server/SDK/tools **1.58.1** and **1.59.0**. Tests covered Git subdirectory and backend-local installation, trusted activation, recorded activity, pagination, timestamp controls, keyboard selection, narrow layout, refresh, update, disable, re-enable, uninstall, backend isolation, and connection loss. See the [verification record and repeatable checks](../../docs/openhands-canvas-validation.md) for the exact combinations and scope.

These were isolated local backends with synthetic SDK-valid histories, not production deployments. No model inference or agent tool execution was requested. Automated malformed-response, retention and late-disposal regressions also use synthetic fixtures. The released desktop installer, protected backends, OpenHands Cloud, and live model/tool activity were not verified. These checks do not establish compatibility with every release.

The existing file-based adapter remains available for CLI captures in the [transcript adapter guide](../../docs/adapters.md).

Primary references:

- [Apps (Beta)](https://docs.openhands.dev/openhands/usage/agent-canvas/canvas-extensions).
- [Upstream minimal App fixture in Canvas 1.34.0](https://github.com/OpenHands/OpenHands/tree/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/src/fixtures/canvas-extensions/demo-page).
- [Released Canvas host API types](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/src/types/canvas-extension.ts) and [authenticated request helper](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/src/api/canvas-extensions-service.ts).
- Agent Server [conversation routes](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-agent-server/openhands/agent_server/conversation_router.py), [event routes](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-agent-server/openhands/agent_server/event_router.py), and [page and sort models](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-agent-server/openhands/agent_server/models.py).
- [SDK event timestamp definition](https://github.com/OpenHands/software-agent-sdk/blob/c3985a4c1fc8ecb8fdc196610754a82aa0e3464a/openhands-sdk/openhands/sdk/event/base.py).

Licensed under the repository's [MIT license](../../LICENSE). This is an independent community integration, not an OpenHands endorsement.
