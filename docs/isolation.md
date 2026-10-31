# Domain isolation

Runward uses one authenticated server process and persisted store per domain/environment. A **domain** is an operator-defined data-access scope, such as personal or company work. Every reader of that domain can see its enrolled sources, including raw event details. Split projects into different domains when they require different readers, even if they use the same provider account.

This implements the P0 separate-instance boundary from [issue #3](https://github.com/K-kiron/runward/issues/3). The proposed P1 overview that shares only approved metadata across domains is not implemented. There is no combined raw-data endpoint, shared-process tenant manager, provider login broker, or automatic account discovery. Record retention is currently bounded by fixed limits, not configurable per-source policies.

## Start separate domains

```sh
node cli.mjs --domain personal --environment laptop --port 4317
node cli.mjs --domain company --environment work-vm --port 4318
```

Run each command in its intended environment. Domain and environment IDs are lowercase slugs of at most 64 characters. The default stores are `~/.runward/domains/<domain>/<environment>/state.json`. `--data` selects another file; `--port` selects the local listener. Different domain/environment settings cannot open the same saved store.

Each process binds to `127.0.0.1`, prints its own capabilities, and serves only its domain. The browser connects to the page's own origin and displays the authorized domain/environment after login. It has no arbitrary-backend URL manager. Separate tabs and ports are useful organization, but do not restrict an unrestricted same-user process or replace filesystem and credential isolation.

## Explicit source configuration

Use `--config personal.json` for stable source names and controlled generation changes:

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

Paths are resolved relative to the config file, not the shell's working directory. The selected file must exist at enrollment. Do not combine `--config` with `--domain`, `--environment`, or `--watch`. Tokens do not belong in this config.

The enrollment fields have distinct purposes:

| Field | Meaning |
| --- | --- |
| `domain.id`, `domain.environmentId` | Operator-selected data-access boundary and environment. |
| `id` | Stable source name inside the domain; also used by the purge command. |
| `provider` | Reader format, such as `codex`, `claude`, `dsh`, `opencode`, `openhands`, or `gemini`. Use `custom` for a source that only receives event API submissions. |
| `toolInstanceId` | Operator-selected label for the installation/configuration that owns this source. |
| `generation` | Positive integer identifying this source enrollment. Use a new generation after a reviewed identity, configuration, backend, or file change. |
| `identity` | Optional opaque alias. A string is stored as `operator-asserted`; omission becomes `{ "alias": null, "evidence": "unknown" }`. Neither is verified provider identity. |
| `path` | Explicit transcript file for a watched source. Omit it for event API ingestion. |

Changing a stored enrollment under the same source/generation fails instead of relabeling history. Use a new generation in the config and restart after reviewing the new input. Previous records retain their original source/generation unless explicitly purged. Only one generation per source ID can be active in a configuration. The store retains historical enrollment metadata.

The `--watch "provider=/path/file"` shorthand enrolls generation 1 with generated source/tool-instance IDs and an unknown identity. The startup ingest-token labels identify the generated source ID and generation. Use an explicit config when you need to manage generations. With no configured sources, the server creates the event API source `api`, generation 1.

Producer record IDs and references are namespaced by domain, environment, source and generation. Source-ingest authorization supplies the scope; payload fields cannot choose another domain or source. A project name, basename, model name, terminal, or currently selected login is not evidence of historical account ownership. Runward does not inspect provider credential files to discover accounts.

The inspector shows the server-supplied source ID, tool instance and generation. Identity aliases are labeled **Operator-supplied identity · unverified**; missing aliases remain **Identity unverified**. These labels help distinguish sources without claiming account verification.

## Capabilities and browser sessions

| Capability | Allowed operations | CLI environment variable |
| --- | --- | --- |
| Read | Domain snapshot, stream, and session metadata | `RUNWARD_READ_TOKEN` can reuse a matching issued root token at server startup. |
| Action | Read operations plus coordination and source purge | `RUNWARD_TOKEN` can reuse a matching issued root token at startup; the purge command also uses it. |
| Source ingest | Submit producer events for one enrolled source/generation; no snapshot reads or coordination | `RUNWARD_INGEST_TOKEN` supplies the ingest command's credential. |

New root capabilities are generated at startup unless matching read/action tokens are supplied. Their format is bound to the domain/environment and role; ingest capabilities additionally bind a source/generation. A token issued for another scope is not a reusable password for this instance. Use secure runtime entry for credentials; keep them out of command arguments, URLs, config files, transcripts, screenshots, and repositories.

All activity and session reads require `Authorization: Bearer ...`, including `/api/state`, `/api/session`, and `/api/stream`. The health route returns only a non-sensitive health result without authentication. Host/Origin checks supplement authorization. There is no per-project reader role: a read or action capability grants the entire instance's authorized snapshot, before any UI filter is applied.

The browser sends its root read/action token only to `POST /api/session`, receives a derived session, and forgets the root token. Sessions last at most eight hours and are invalidated by server restart or revocation of their parent capability. The page keeps its session token only in memory and uses authenticated fetch streaming, with no token URLs, cookies, `localStorage`, or `sessionStorage`.

**Lock** synchronously clears snapshots, filters, inspector content, pending responses and the session credential, closes streams, then requests `DELETE /api/session` to revoke the derived session. If the server cannot receive that request, local clearing still happens; the server-side session ends at expiry or server shutdown. Revocation closes an existing server stream; an authorization failure on the client clears the page and requires a new root-token exchange. A changed server instance or domain/environment also requires reauthentication. Delayed responses from a previous session cannot repopulate the page. Transient network errors may retain the last snapshot only within the same still-selected authority.

An operator alias is required for coordination but optional for reading. It is a display label supplied by the person, not an authenticated identity or per-person authorization rule. Handoff claims assign work; they do not execute an agent.

## Source enrollment and file lifecycle

Enrollment resolves the selected pathname to a canonical file and records its filesystem identity. Generated `fileIdentity` metadata is persisted with the source; do not construct or copy it into a config by hand. On startup, the newly enrolled file is compared with the stored enrollment. A replaced file or changed canonical target requires a new generation.

While a watcher runs, it checks the selected path/link and open file before and after reading, verifies the previously read byte prefix, and allows only append growth. Replacement, symlink/junction retargeting, disappearance, truncation, or rewriting earlier bytes pauses that source. A filesystem without stable file identity is rejected. Each selected transcript is bounded to 32 MiB.

This guard is deliberately strict: an otherwise legitimate JSON export rewritten in place or replaced atomically is a source change too. Keep a reviewed export unchanged, or explicitly enroll a new generation for the new export. Parser support for a format does not promise that its producer writes append-only files.

The append-prefix hash is process-local. **A same-inode content rewrite performed while Runward is stopped is not detected at restart by this guard.** Persistent file identity alone does not authenticate file content, provider identity, or provenance. Account changes that continue appending to the same file are also not automatically detected. Review upstream account/backend changes and enroll a new generation or a different domain before collection; unresolved provenance remains unknown or operator-asserted.

Removing a source from configuration stops its collection after restart, but does not delete previously stored history. It also does not remove the source transcript. Use purge when stored history must be removed.

## Legacy migration

The version 2 domain store replaces the legacy unscoped snapshot. The old default `~/.runward/state.json` is never opened automatically and remains untouched. Explicitly pointing a live instance at a legacy file fails with a migration requirement; it does not silently classify old records under the current login.

Review a legacy file locally and select only agent IDs whose ownership you can establish. Import them into a **fresh, nonexistent** output file:

```sh
node cli.mjs migrate legacy.json --agent reviewed-agent-id --domain personal --environment laptop --source-id reviewed-history --data personal-new.json
node cli.mjs --domain personal --environment laptop --data personal-new.json
```

Repeat `--agent` for additional reviewed IDs. Migration copies those agents and their related records into a namespaced `legacy-import` source at generation 1. The source has unknown provider identity. It preserves the original file and refuses to overwrite an existing destination. Perform separate explicit selections for different domains. Leave unclassified records outside active serving; the currently logged-in account is not evidence for assigning old history.

Migration preserves selected text, including any secrets it contains. It does not redact or change upstream evidence. Original legacy files and backups need their own access controls and retention decisions.

## Purge and retention

To remove a source's stored records, supply the running server's action capability through `RUNWARD_TOKEN`, then run:

```sh
node cli.mjs purge editor-session --port 4317
```

Purge removes agents, events, runs, handoffs and attention records for **all stored generations** of that source ID. It retains enrollment tombstones, revokes their ingest capabilities, and rejects replay into those generations. Queued dispatch checks prevent revoked sources from restoring history. A watcher that receives the revoked-source response pauses rather than retrying it; unchanged files may still be polled until the watcher observes revocation or the configuration is removed and the process restarted.

A purged generation left in startup configuration makes startup fail. Remove it, or deliberately enroll a new generation after reviewing whether collection is appropriate. A new generation can import the same content again if you explicitly select it; purge is not a permanent prohibition on operator-authorized future imports.

Purge updates connected viewers but cannot recall data already copied, exported, screenshotted, or retained by another reader. It does not erase source transcripts, legacy files, backups, operating-system caches, or disk blocks securely. Removing an entire domain's saved data likewise requires a separate deliberate filesystem operation after stopping its server; there is no implicit deletion when a window closes.

Stores are limited to 8 MiB, including enrollment metadata, and use the fixed [record limits](events.md). Oversized mutations are rejected before persistence. A canonical file lock prevents two processes writing one store. After an interrupted run, verify that its writer is stopped before manually removing a stale `.lock`; Runward does not guess. Corrupt or scope-mismatched files are preserved and stop startup. Writes are serialized, flushed, and atomically replaced.

## Provider scenarios and identity limits

The S1–S8 matrix in [issue #3](https://github.com/K-kiron/runward/issues/3) motivates these rules. The following are deployment principles grounded in each product's documented mechanisms, not a claim of simultaneous accounts in one shared credential store or live validation of those login combinations. Follow organization policies and the current official instructions for your provider version.

| Scenario | Apply this rule |
| --- | --- |
| S1: Different tools, personal/company identities | Use separate Runward domains when readers differ. Independent [Codex authentication](https://learn.chatgpt.com/docs/auth) and [Claude authentication](https://code.claude.com/docs/en/authentication) do not isolate shared OS files or inherited credentials. |
| S2: Multiple Claude Code CLI accounts | Follow the documented [separate `CLAUDE_CONFIG_DIR` workflow](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts), including its exception for Console sign-ins without API keys. Record the effective environment; the terminal name is insufficient. |
| S3: Claude Desktop and CLI credential mechanisms | Normal Desktop OAuth and CLI API/cloud-provider configuration follow different [credential rules](https://code.claude.com/docs/en/authentication#credential-management), while [configuration can be shared](https://code.claude.com/docs/en/desktop#shared-configuration). Different frontends alone do not establish isolation. |
| S4: Local Codex and an independently provisioned remote/VM CLI | Assign separate environment IDs and separately managed credentials. [Authentication](https://learn.chatgpt.com/docs/auth) and [`CODEX_HOME` configuration](https://learn.chatgpt.com/docs/config-file/environment-variables) do not make a project directory a sandbox or prove independent local login stores. |
| S5: OpenCode V2 saved accounts and clients | Account switching and a shared server are distinct from tenant isolation. Review [provider accounts](https://dev.opencode.ai/v2/docs/cli/providers) and the [server architecture](https://dev.opencode.ai/v2/docs/cli); bind sources to the actual server and use a new generation after reviewed identity changes. |
| S6: Gemini CLI configuration and authentication contexts | Separate roots need separately scoped [authentication](https://geminicli.com/docs/get-started/authentication/) too. [`GEMINI_CLI_HOME`](https://geminicli.com/docs/reference/configuration/) does not isolate inherited environment variables, external ADC, or shared project settings by itself. |
| S7: OpenHands personal/company backends | Keep collection in the owning [backend](https://docs.openhands.dev/openhands/usage/agent-canvas/backends). The Runward Canvas App supports its documented local backends only; a Cloud backend entry does not imply App compatibility. |
| S8: DSH Desktop/CLI and profiles | A shared `DSH_HOME` is a shared source environment, not an account boundary. Review the [provider guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md) and [Desktop reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md). Profiles do not establish separate credential stores by themselves. |

One account can own projects with different confidentiality requirements. A model-provider login also says nothing about the SCM, MCP, or cloud credentials a process can use. Runward's synthetic namespace and session tests validate its own boundaries; they do not certify vendor login behavior, deployment permissions, or account change detection.

## Filesystem, operating system, and host trust

Runward does not redact raw text or encrypt it at the application layer. Protect the config, store, lock/temporary files, transcripts, backups, terminal output and runtime credentials. POSIX files/directories are created with restrictive requested modes, subject to existing directory permissions. **Windows ACLs are not set or repaired automatically by these mode flags.** Review the folder's Security / Advanced permissions and effective access for the intended Windows account; coordinate permission changes with your administrator rather than treating a default home-directory ACL as proof of isolation.

For a strong personal/company boundary, use separate OS accounts with enforced permissions, an appropriately restricted sandbox, or separate VMs. Ensure shared folders, inherited environment variables, credential stores, browser extensions, clipboard workflows, and loopback access do not reconnect the domains. An administrator or unrestricted process running as the same user remains trusted. Separate ports, aliases, filters, config homes, and source IDs alone cannot enforce that boundary. Runward does not change OS security policy and cannot control an upstream agent's uploads, telemetry, or tool permissions.

The standalone server makes no outbound requests and uses no telemetry, CDN, remote fonts, or hosted model API. Keep it on loopback; public tunnels and multi-user hosting are outside this deployment model.

The optional [OpenHands Canvas App](../apps/openhands/README.md) follows the active backend's authenticated helper and uses read-only operations. It does not use these standalone tokens or merge domain stores. Its Shadow DOM scopes styles, not authority: enabled Apps execute within the trusted Canvas browser context under the [host trust model](https://docs.openhands.dev/openhands/usage/agent-canvas/canvas-extensions#trust-model). Review installed App revisions and backend deployment boundaries; GET-only behavior is not a sandbox against other trusted host code.
