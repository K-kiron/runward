# Agent Canvas App verification

The installable package is [apps/openhands](../apps/openhands/README.md). This record separates automated parser checks, real host tests and unverified environments so contributors can repeat the relevant checks before distributing a new revision.

## Checked versions

Verification date: **2026-10-30 UTC**. App version **0.1.0**, source revision `bdccc609874a6ca9350dce62cf0b219fb96f00d6`.

- Windows, Node.js **24.15.0**, Python **3.12.14**.
- Official **Agent Canvas v1.34.0**, released source commit `6c120073f5a1e1c838ba6fdd9a075c79ff997b98`, using its documented frontend-only development mode. The real Canvas runtime, registry, routes and authenticated request helper were used, with mocks disabled and no host source patches.
- Official Agent Server, SDK and tools **1.58.1**, the version pinned by that Canvas release, and separately **1.59.0**. Each backend had fresh, separate configuration, persistence and workspaces, on loopback, without session keys or model credentials.

The histories were clearly labeled synthetic fixtures, validated with the installed SDK. Action and observation pairs described simulated tool activity; no model inference or agent tool execution was requested. Additional user messages were submitted with `run:false`.

## Results

| Check | Environment and result |
| --- | --- |
| Canonical repository checks | `npm run check`: 110 tests passed. The merged source also passed the existing Linux/Windows, Node.js 22/24 CI matrix. |
| Official package format | The registry's `validate-extension.mjs` accepted both the canonical App directory and the portable distribution. |
| Git installation | Canvas 1.34.0 / Server 1.59.0 installed `github:K-kiron/runward`, Ref `bdccc609874a6ca9350dce62cf0b219fb96f00d6`, Path `apps/openhands`, initially disabled. The served bundle and raw manifest matched the committed Git blobs exactly. |
| Portable local installation | Both server versions installed the self-contained package through the real Add app form. It required no Runward server or installation build. |
| Activation and cleanup | Trusted activation exposed the page. Disable removed navigation; re-enable restored it. Remounting cleared the offset and left automatic refresh disabled. Uninstall removed the installation and navigation on both tested server versions. |
| Real HTTP pagination | Server 1.59.0 supplied 325 synthetic messages over four event pages. Canvas displayed all 325 source events and spans, limited waterfall markers to 300 with a notice, and expanded the event console from 100 to 200 entries using Show more. |
| Timing and pairing | Both server versions displayed recorded action/observation pairs, overlaps, gaps and explicit failures. Naive server timestamps remained untimed by default. An invalid `+15:00` offset was rejected; an explicit `-04:00` interpretation was labeled and preserved timezone-bearing event times. |
| Interaction and layout | Keyboard Enter selected an error and exposed its recorded six-second interval. A 390-by-844 viewport had no horizontal App overflow. Automatic refresh retained event selection and keyboard focus. |
| New events and text rendering | Manual refresh picked up a new `run:false` user message. Literal `<b>...</b>` markup appeared as text, with no injected bold element. |
| Disposal | After enabling automatic refresh and navigating away through Canvas, backend logs showed no further selected-conversation event searches over a 12-second observation window. Unrelated host requests continued. |
| Git update | Updating the pinned Git installation advanced its installation timestamp and preserved its ref and enabled state. |
| Local source update | A harmless comment appended only to a disposable package copy was served after Update, with manifest version unchanged at 0.1.0. Enabled state was preserved and the updated page mounted successfully. Canonical source and the submission candidate were unchanged. |
| Backend isolation | Switching to the separate 1.58.1 backend removed the previous backend's page and navigation before the App was installed there. Offset and refresh state did not carry across. Uninstalling on 1.58.1 left the separate 1.59.0 installation enabled until it was independently uninstalled. |
| Empty history | The 1.58.1 backend's empty conversation displayed zero source events, zero spans and an explanatory empty state. |
| Connection loss and recovery | Stopping only the 1.58.1 backend produced a visible error and retained the previous 11-event, eight-span snapshot. Restarting it with the same configuration and persistence, then selecting Refresh, restored the connection and cleared the error without losing the recorded data. |

The official registry candidate additionally passed `tests/test_apps_catalog.py` (2 tests), its catalog export check and an npm pack dry run containing the manifest, bundle, README and original MIT license. Its general synchronization check encountered existing Windows materialized-symlink and text-encoding limitations; a complete upstream CI run was not established by those focused checks.

## Repeat the user flows

1. Run `npm run check` from a clean Runward checkout. After changing bundled source, run `npm run build:canvas` first and include the regenerated entrypoint.
2. Use a supported local Agent Server and the real Canvas frontend. Follow the [installation instructions](../apps/openhands/README.md); review the exact resolved revision and trusted-code notice. Verify the App installs disabled before enabling it.
3. Inspect disposable recorded conversations: empty history; offset-bearing and naive timestamps; an action/result pair with a known interval; a recorded explicit failure; and more than 100 events. Confirm counts, pairing, warnings and continuation pages against the source records.
4. Select an event with the keyboard, refresh, and check that focus and selection survive. Add a synthetic message with `run:false`, refresh, and verify that its text remains literal. Exercise a narrow viewport and restore the browser's normal sizing afterward.
5. Opt into automatic refresh, then leave the page using Canvas navigation. Confirm selected-conversation event requests stop. Disable, re-enable and uninstall the App; verify navigation and page cleanup.
6. Test Update from both a reviewed Git source and a disposable local directory. A pinned Git ref remains pinned. For a local update, compare the served bundle with a harmless changed copy, preserving the original package and version.
7. Switch to a separately configured backend. Verify App installation and enabled state are backend-specific and that no old conversation snapshot or offset remains. Interrupt only the disposable backend and verify a clear error preserves the last snapshot. Restart it with the same state, refresh, and confirm that the error clears and recorded activity remains usable.

## Distribution and limits

The canonical maintained source remains in Runward. A registry distribution can contain the committed `canvas-extension.json`, self-contained `extension.js`, a portable README and the original MIT license; update these from one reviewed canonical revision. Do not copy only `src/`, whose imports refer to shared repository modules, or maintain a separately edited bundle.

These tests establish the recorded local read-only flows above. They do not verify the released desktop installer, session-key-protected backends, production deployments, OpenHands Cloud, every host/server version, or actual agent model/tool execution. Automated malformed-page and late-response tests are controlled fixtures, not evidence of every possible network failure.

Primary references: [Apps documentation](https://docs.openhands.dev/openhands/usage/agent-canvas/canvas-extensions), [released Canvas source](https://github.com/OpenHands/OpenHands/tree/6c120073f5a1e1c838ba6fdd9a075c79ff997b98), and [official registry package conventions](https://github.com/OpenHands/extensions/blob/main/apps/README.md).
