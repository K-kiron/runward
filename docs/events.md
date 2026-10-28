# Event API

Runward accepts explicit facts from your runner. It does not infer test outcomes from prose or connect directly to model APIs.

The server listens at `http://127.0.0.1:4317` by default. Send `POST /api/events` with `Content-Type: application/json` and `Authorization: Bearer <write-token>`. Supply one command or an array of up to 1,000 commands (at most 1 MiB). The complete request is validated and committed atomically. Commands in a batch run in order, so register an agent before referencing it.

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

Responses are `{ "ok": true, "revision": 1 }`. Errors return `{ "error": "..." }` with HTTP 400 for validation, 401 for a missing/incorrect token, 403 for foreign Host/Origin, 409 for a coordination conflict, 413 for a large body, or 415 for a different content type. Save failures return 500 and do not update the in-memory state.

## Commands

| Type | Required data | Optional data |
| --- | --- | --- |
| `agent.upsert` | `id` | `name`, `project`, `provider`, `status`, `startedAt`, `lastSeen`, `cwd`, `contextUsed`, `contextLimit` |
| `span.upsert` | `id`, `agentId` for a new span | `laneId`, `label`, `kind`, `startedAt`, `endedAt`, `detail` |
| `run.upsert` | `id`, `agentId` for a new run | `project`, `model`, `status`, `startedAt`, `endedAt`, `checksPassed`, `checksTotal`, `cost`, `failure` |
| `handoff.offer` | `id`, `agentId`, `title` | `detail`, `createdAt` |
| `handoff.claim` | `id`, `owner` | — |
| `handoff.release` | `id`, `owner` | — |
| `handoff.complete` | `id`, `owner` | — |
| `attention.open` | `id`, `agentId`, `title` | `detail`, `createdAt` |
| `attention.resolve` | `id` | — |

Upserts merge supplied fields into an existing record. Reuse IDs to close a span or update a run. New handoff/attention IDs must be unique; offering an existing handoff does not reopen it. Unknown fields and command types are rejected.

- Agent states: `working`, `idle`, `waiting`, `offline`, `unknown`. Missing state defaults to `unknown`. Last-seen age is independent of state; the dashboard marks freshness older than two minutes as stale.
- Span kinds: `thinking`, `tool`, `subagent`, `error`, `message`. New spans default to `message`, lane `main`, and `endedAt: null`. Send equal start/end timestamps for an instant. A null end denotes an open span; it is not proof that the underlying process is still alive.
- Run states: `running`, `passed`, `failed`. Running runs must have a null end; finished runs require an end. Checks and cost are nullable. Cost is USD; do not send an estimate as an observed charge without labeling its origin in your runner.
- All dates are ISO UTC strings ending in `Z`, with at most three fractional digits. End times cannot precede start times. If a new record omits its start timestamp, server receipt time is used; an upsert does not automatically refresh existing timestamps.
- Context/check counts are nonnegative safe integers or null. Costs are nonnegative finite numbers or null. A context limit of zero is not a usable denominator. Unknown values are not zero.
- IDs are at most 160 characters. Names and labels are at most 240, provider 80, titles 500, paths 2,048, and details/failure text 20,000 characters. Unsupported control characters are rejected.

## Coordination

Handoffs follow `offered → claimed → completed`, or `claimed → offered` on release. Claiming requires an offered item. Releasing/completing requires the recorded owner's name. Concurrent claims are serialized; only one wins. Attention resolution is explicit and cannot be repeated.

Owner names are labels supplied by a trusted local operator. They are **not authenticated individual identities**. Everyone holding the write token has the same authority; this is not access control between operators.

`POST /api/actions` is a narrower dashboard endpoint accepting one handoff command or `attention.resolve`. It uses the same token and state transitions.

## Reading and updates

- `GET /api/state`: a complete snapshot with `version`, `revision`, `agents`, `runs`, `handoffs`, `attention`, `events`, `mode`, `instanceId`, and `serverTime`. The instance ID changes after a server restart so clients can accept a new revision sequence.
- `GET /api/stream`: server-sent `state` events containing the same full snapshot. On reconnect, the latest full state is sent; there is no incremental replay contract.
- `GET /api/session`: `{ "writable": true|false }` based on the supplied bearer token.
- `GET /api/health`: `{ "ok": true }`.

Read endpoints are unauthenticated on the local machine. Up to 16 event streams are supported. Foreign browser origins are rejected and CORS is not enabled.

## Retention and storage

At most 500 agents, the latest 5,000 spans, and the latest 1,000 runs are retained. Old spans/runs are pruned by start timestamp. Handoffs and attention each retain at most 1,000 records; completed/resolved records are pruned first, and exceeding the limit with unresolved records rejects the write. Agent records are not automatically removed.

State is a version-1 JSON snapshot, written through a flushed same-directory temporary file followed by replacement. This protects against partial writes; it is not a database with cross-process locking or a guarantee against every filesystem/power failure. Run only one writer per state file. A corrupt or unsupported snapshot stops startup and is preserved.

`examples/events.json` is a small synthetic integration example, not a real project transcript. Its dates are fixed, so it will appear historical when imported later.
