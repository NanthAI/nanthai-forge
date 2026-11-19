### Hosted friction and decisions

A hosted ROOT sends `friction`,
`decide` and `decisions` to hosted records. These commands are deliberately absent from the advertised
capabilities array so released clients continue to parse it. A server without the
record endpoints returns `HOSTED_ACTION_UNSUPPORTED`; the client retains the
operation and never falls back to writing Mac Work.

`friction-list {id?,status?,area?,laneId?,search?,limit?,cursor?}` reads one newest-first
page of captured friction (default `status:"open"`, `limit` 50, at most 100 rows
scanned) as `items` (`id`, `laneId?`, `title`, `area`, `at`, `detail`, `status`,
`reason?`, `planningItemId?`, `fixedByLaneId?`), `scanned` and `nextCursor`. A page cuts
each `detail` at 400 characters and then adds `detailTruncated:true` and `detailLength`;
`friction-list {"id":"…"}` returns that friction's detail up to 16,000 characters (same flags
if still cut). Filters
apply inside the scanned page, so a sparse match can return few items with a
`nextCursor`; follow it. `id` (a full id or a hex prefix of at least 8 characters, as in
planning) returns that one friction whatever its status or age: one indexed range read, no
page scan, `BAD_ARGUMENT` listing the candidates when the prefix is ambiguous. `x friction-triage
{frictionIds,status,reason?,laneId?,planningItemId?}` takes at most 50 ids or id prefixes
(resolved in the same call; the stored event keeps the full ids): `dropped` with `reason` dismisses, `planned` with
`planningItemId` (or a `reason`) links an Issue, `fixed` names the fixing `laneId`
(the checkout's Lane when omitted), `open` reopens. Triage is an append-only event
that also patches each capture's current status, so a list is one indexed page with
no join; a replay of the same `operationId` changes nothing. The Issue id is stored,
not checked for existence. Reads cost one query and idle costs none.

Friction permits the owner and project contributors. Decisions permit the owner
and owner-assigned decision maintainers (`projectHostedDecisions:setMaintainer`,
with `projectId`, `operationId`, `actor`, `enabled`). This grant is separate from
guidance maintenance and still requires current contributor access. Both record
commands use one mutation, retain native record shapes and original operation IDs,
and reject changed replay inputs with `WORK_OPERATION_CHANGED`. Decisions remain
append-only. `decisions` returns `page`, `isDone`, `continueCursor`; pass the cursor
back as `cursor`. Supersession is derived from retained replacement records after
reading the applicable pages. Target-filtered pages may exclude cross-target
replacement records; read all targets when deriving complete supersession.

Hosted briefs read a bounded window of the latest
100 hosted decisions and state incomplete coverage when more exist. The web
Decisions page still reads the native Work projection and needs separate hosted
query/version wiring.

The lead can explicitly import native bound records after deploying the API:

```sh
node scripts/import-hosted-records.mjs BOUND_OWNER_ROOT
node scripts/import-hosted-records.mjs BOUND_OWNER_ROOT --apply
```

The default is a read-only dry run. The importer pins the indexed native manifest,
reads at most 100 records at a time and sends one query (preview) or mutation
(apply) per page. It preserves original decision/friction record bytes and IDs,
including supersession and triage history. Repeating apply skips identical records;
a conflicting existing ID returns `WORK_OPERATION_CHANGED`. This is an additive
copy and does not delete native records. Import does not require referenced native
Intents/Lanes to have been migrated, and preserves their references as recorded.
