# Event API

Runward accepts explicit facts from your runner. It does not infer test outcomes from prose or connect directly to model APIs.

Start a live instance with an explicit domain and environment, or use a [source configuration](isolation.md#explicit-source-configuration):

```sh
node cli.mjs --domain personal --environment laptop --port 4317
```

With no configured sources, this enrolls the event API source `api` at generation 1. The startup output prints separate read, action, and source-ingest capabilities. Send `POST /api/events` to `http://127.0.0.1:4317` with `Content-Type: application/json` and `Authorization: Bearer <source-ingest-token>`. Supply one command or an array of up to 1,000 commands (at most 1 MiB). The complete request is validated and committed atomically. Commands in a batch run in order, so register an agent before referencing it.

The credential binds the domain, environment, source and generation. Payload fields or source headers cannot select another scope. Send producer-local IDs; the server namespaces record IDs and agent references before storage. Reusing an ID in another enrollment cannot update the first enrollment's record. Lane IDs remain display/grouping labels within an agent. An agent's stored provider comes from its enrollment, not a payload override.

```json
{
  "type": "agent.upsert",
  "data": {
    "id": "worker-7",
    "name": "API migration",
    "project": "Harbor",
    "provider": "Custom",
    "status": "working",
    "startedAt": "2026-10-28T12:00:00.000Z",
    "lastSeen": "2026-10-28T12:00:00.000Z"
  }
}
```

Responses are `{ "ok": true, "revision": 1 }`. Errors return `{ "error": "..." }` with HTTP 400 for validation, 401 for a missing, incorrect, expired or revoked token, 403 for an insufficient capability or foreign Host/Origin, 409 for a coordination conflict, 413 for a large request or store, or 415 for a different content type. Save failures return 500 and do not update the in-memory state.

For a JSON command file, supply the matching source capability through `RUNWARD_INGEST_TOKEN`, then run:

```sh
node cli.mjs ingest examples/events.json --port 4317
```

The ingest capability cannot read snapshots, create browser sessions, claim work, or purge history. Tokens belong in runtime credentials, never in event files, URLs, source configuration, or repositories. See [capabilities and browser sessions](isolation.md#capabilities-and-browser-sessions).

## Source ingestion commands

| Type | Required data | Optional data |
| --- | --- | --- |
| `agent.upsert` | `id` | `name`, `project`, `provider`, `status`, `startedAt`, `lastSeen`, `cwd`, `contextUsed`, `contextLimit` |
| `span.upsert` | `id`, `agentId` for a new span | `laneId`, `label`, `kind`, `startedAt`, `endedAt`, `detail` |
| `run.upsert` | `id`, `agentId` for a new run | `project`, `model`, `status`, `startedAt`, `endedAt`, `checksPassed`, `checksTotal`, `cost`, `failure` |
| `handoff.offer` | `id`, `agentId`, `title` | `detail`, `createdAt` |
| `attention.open` | `id`, `agentId`, `title` | `detail`, `createdAt` |

Upserts merge supplied fields into an existing record. Reuse IDs to close a span or update a run. New handoff/attention IDs must be unique; offering an existing handoff does not reopen it. Unknown fields and command types are rejected.

- Agent states: `working`, `idle`, `waiting`, `offline`, `unknown`. Missing state defaults to `unknown`. Last-seen age is independent of state; the dashboard marks freshness older than two minutes as stale.
- Span kinds: `thinking`, `tool`, `subagent`, `error`, `message`. New spans default to `message`, lane `main`, and `endedAt: null`. Send equal start/end timestamps for an instant. A null end denotes an open span; it is not proof that the underlying process is still alive.
- Run states: `running`, `passed`, `failed`. Running runs must have a null end; finished runs require an end. Checks and cost are nullable. Cost is USD; do not send an estimate as an observed charge without labeling its origin in your runner.
- All dates are ISO UTC strings ending in `Z`, with at most three fractional digits. End times cannot precede start times. If a new record omits its start timestamp, server receipt time is used; an upsert does not automatically refresh existing timestamps.
- Context/check counts are nonnegative safe integers or null. Costs are nonnegative finite numbers or null. A context limit of zero is not a usable denominator. Unknown values are not zero.
- IDs are at most 160 characters. Names and labels are at most 240, provider 80, titles 500, paths 2,048, and details/failure text 20,000 characters. Unsupported control characters are rejected.

## Coordination

Handoffs follow `offered → claimed → completed`, or `claimed → offered` on release. Claiming requires an offered item. Releasing/completing requires the recorded owner's name. Concurrent claims are serialized; only one wins. Attention resolution is explicit and cannot be repeated.

Owner names are labels supplied by a trusted local operator. They are **not authenticated individual identities**. Everyone holding an action capability for the domain has the same authority; this is not access control between operators.

`POST /api/actions` accepts one command with an action capability, issued at startup or derived from it. The CLI startup variable for a reusable action capability is `RUNWARD_TOKEN`. The endpoint does not accept a source-ingest capability.

| Command | Required data | ID convention |
| --- | --- | --- |
| `handoff.offer` | `id`, `agentId`, `title` | Use the agent ID from the authorized snapshot and a new producer-local offer ID; the server assigns its source namespace. Optional `detail` and `createdAt` are supported. |
| `handoff.claim` | `id`, `owner` | Use the handoff ID from the snapshot. |
| `handoff.release` | `id`, `owner` | Use the handoff ID from the snapshot. |
| `handoff.complete` | `id`, `owner` | Use the handoff ID from the snapshot. |
| `attention.resolve` | `id` | Use the attention ID from the snapshot. |

`POST /api/sources/{sourceId}/purge` also requires an action capability. It removes that source's records across all stored generations, retains revocation tombstones, revokes ingest access, and rejects replay into those generations. It does not delete source transcripts or backups. See [purge and retention](isolation.md#purge-and-retention).

## Reading and updates

Every activity and session endpoint requires `Authorization: Bearer ...`. A read capability (`RUNWARD_READ_TOKEN` for reuse at startup) grants the entire domain snapshot; project filters do not restrict server-side access. An action capability includes read access. Source-ingest capabilities have no read access.

| Endpoint | Capability | Result |
| --- | --- | --- |
| `GET /api/state` | Read or action, root or derived | Complete record snapshot plus `domain`, `sources`, `provenance`, `mode`, `instanceId`, and `serverTime`. |
| `GET /api/stream` | Read or action, root or derived | Server-sent `state` events containing the same full snapshot. Reconnect sends current state; there is no incremental replay contract. |
| `GET /api/session` | Read or action, root or derived | `readable: true`, boolean `writable`, `domain`, and `instanceId`. |
| `POST /api/session` | Root read or action only | The same access metadata plus `sessionToken` and `expiresAt` (Unix milliseconds). |
| `DELETE /api/session` | Read or action, root or derived | Revokes the supplied capability and any sessions derived from it; returns `{ "ok": true }`. |
| `GET /api/health` | None | `{ "ok": true }`, without activity data. |

The browser exchanges an issued root capability for a derived session, keeps it only in memory, and uses authenticated fetch for streaming. Derived sessions expire within eight hours; restart or parent revocation invalidates them. Revocation closes their streams. Up to 64 derived sessions and 16 event streams are supported. Foreign browser origins are rejected and CORS is not enabled.

The HTTP snapshot retains the record model's `version: 1`; it is not the on-disk version-2 envelope. Its source descriptors include revocation status but omit enrollment paths and file identities. Event details and agent working directories can still contain private paths. A changed `instanceId`, domain or environment requires browser reauthentication; see [browser clearing and lock behavior](isolation.md#capabilities-and-browser-sessions).

`provenance` maps each scoped agent ID to `{ sourceId, toolInstanceId, generation, identity }`, derived from the server's enrollment. `identity` is either `{ "alias": null, "evidence": "unknown" }` or an alias with `evidence: "operator-asserted"`. Neither verifies an upstream account. Clients should use this map rather than guess provenance from project names, provider labels, or opaque record IDs.

## Retention and storage

At most 500 agents, the latest 5,000 spans, and the latest 1,000 runs are retained. Old spans/runs are pruned by start timestamp. Handoffs and attention each retain at most 1,000 records; completed/resolved records are pruned first, and exceeding the limit with unresolved records rejects the write. Agent records are not automatically removed.

The on-disk store is a version-2 envelope with `version`, `domain`, `sources`, `state`, and `revokedSources`. `state` contains the validated version-1 record snapshot; every record ID and agent reference is scoped to its enrolled domain/environment/source/generation. `sources` retains normalized enrollment metadata, including historical generations and generated file identity for watched files. `revokedSources` records revoked `sourceId:generation` keys. At most 1,000 source enrollments, including historical generations, are retained.

Live storage defaults to `~/.runward/domains/<domain>/<environment>/state.json` and is limited to 8 MiB. One canonical file lock prevents concurrent writers. Writes use a flushed same-directory temporary file followed by replacement. This is not a guarantee against every filesystem or power failure. A corrupt, legacy, unsupported, or scope-mismatched store stops startup and is preserved. After an interrupted run, verify its writer is stopped before removing a stale `.lock`.

The old `~/.runward/state.json` is never loaded automatically. [Explicit migration](isolation.md#legacy-migration) selects reviewed agent IDs, namespaces their related history, preserves the input, and requires a fresh destination. Removing a source from configuration does not erase its existing history; use the authenticated purge operation when needed.

`examples/events.json` is a small synthetic integration example, not a real project transcript. Its dates are fixed, so it will appear historical when imported later.
