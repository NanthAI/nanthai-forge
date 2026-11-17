# Devices, credentials and Lane holders

The shared screen types live in `web/src/app/access-contract.ts` (Issue df06081d).
They describe the rebuilt devices, People and sessions screens; they do not grant
access. Server-side identity and current project access remain authoritative.

A person owns access. A stable device key identifies a device and carries its
settings. A credential is a time-bounded sign-in under that key. A session is an
agent's live presence and holds no durable access. Device settings can narrow the
person's rights; neither a display name nor an agent's declared app/model grants
rights. The stable device code and the short-lived typed approval code are
separate values. Existing CLI credentials remain usable while this expands.

A Lane is the work identity. Its saved head stays fixed across a holder change;
the transition records both holders, actor, time, reason and exact saved head.
Resuming the same app thread keeps its session name. A new thread or process
fallback receives its own name and explicitly takes over an existing Lane.
Holder transitions do not change the landing stop or create a Needs-you request.
A refused save preserves local files and reports that nothing was saved.

## Provisional policies

The C1 implementation keeps four independently named policies in one server-side
module: who may take over; whether a live takeover needs a reason; device-name
visibility; and sign-out versus removal. The current instruction is same-person
sessions or the project owner, a reason for a live holder, owner-only names, and
sign-out retaining key/name/settings while removal revokes the key/settings.
Owner-confirmation lines remain open until the lead records confirmation.
Browser inactivity is one server-side setting, provisionally 14 days. Credential
lifetime and optional narrower durations are separate decisions.

## Read and write budgets

At 400 people, 25 teams, 1,200 devices and 300 daily sessions, and at twice that
scale, screens read bounded pages, never one call per row. Devices and browsers
share one account view; browser sessions use the library's bounded account list
(at most 100), passkeys use its list API. Holder changes are atomic retry-safe
writes using the existing operation identity. No heartbeat or polling is added.
Idle and hidden screens make zero calls. The contract itself changes no runtime
calls, DB I/O, memory, wall time, byte placement or landing cost ($0 per 1,000).
Source bytes remain in R2; identity records stay in Convex. This consolidates
per-session access assumptions; existing screens stay until their replacements
cover their behavior. No new table, CLI command or runtime dependency is added
by this interface landing.

The C1 reader expansion accepts optional device identity/settings and Lane-holder
metadata. Policy `accessIdentities.laneHolders` and `accessIdentities.devices`
are independent rollout settings; absent means off. Readers land before their
writers, and enabling either later uses the existing owner policy mechanism.
Neither setting changes the four provisional decisions described above.

The optional session provenance reader distinguishes client-reported app/thread labels from the server's credential-bound device snapshot. Legacy records keep unknown provenance unknown. Compose and sync readers accept a holder reference before their writers send it. Device renewal receipts reuse the account-owned credential; there is no new table, index, timer or idle write.


## Explicit holders

Projects with `accessIdentities.laneHolders` enabled bind a new Lane to the full
session reference. `nforge agent . whoami` uses the existing status read to show
the person, reported app, device and held Lane. `open` resumes that session;
`open --why REASON` records an explicit takeover. A handover offers the saved
Lane to the named recipient and leaves its current holder in place until the
recipient accepts the offer. Offers and transitions reuse source-operation
receipts; retries return the original result.

Holder changes preserve the saved head and record the previous holder, successor,
actor, time and reason. They neither cancel checks nor discard earlier saves.
Save, sync and compose check the current holder at their existing source reads;
publication checks it again, so a delayed former holder cannot publish over a
successor. A refused save retains local files and captured source. If checkout
fails after a takeover commits, the CLI reports that committed operation and its
retry. Independent local directories preserve unsaved files; sharing one directory
between processes remains an operating-system boundary, not an isolated workspace.

The Sessions screen reads one presence page (25 returned rows, at most 100 rows
or 64 KiB scanned) without a heartbeat. It groups the loaded observations by
person and device and opens window details on demand. A session profile uses the
same filtered read. The Holder screen uses one current-record read and the
existing paginated activity feed, including archived history. No list invents
unreported app, model, device or session provenance. Counts describe the loaded
page, rather than an organisation total. Device labels are projected through the
central owner-visibility policy; public source views omit holder provenance.
The app reuses the existing design-system regions, rows, controls and activity
feed. The source guards reuse existing reads; no ordinary save or landing RPC is
added. Rollout remains off by default pending the owner decisions and cost review.
