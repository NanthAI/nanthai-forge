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
the transition records both holders, actor, time, reason (at most 280 characters) and exact saved head in
the Lane record. The project activity feed, which readers and signed-in visitors of a public project can read,
records only the change's kind and the Lane version. Feed entries written before that rule may still name the
holders and carry the reason.
Resuming the same app thread keeps its session name. A new thread or process
fallback receives its own name and explicitly takes over an existing Lane.
Holder transitions do not change the landing stop or create a Needs-you request.
A refused save preserves local files and reports that nothing was saved.

## Access policies

The C1 implementation keeps four independently named policies in one server-side
module: who may take over; whether a live takeover needs a reason; device-name
visibility; and sign-out versus removal. The approved rules are same-person
sessions or the project owner, a reason for a live holder, owner-only names, and
sign-out retaining key/name/settings while removal revokes the key/settings.
The owner has approved all four policies.
Browser inactivity is one server-side setting, approved at 14 days. Credential
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
Neither setting changes the four approved decisions described above.

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
added. Rollout remains off by default pending activation through the existing owner policy and cost review.


## Stable device approvals

With `accessIdentities.devices` enabled for the selected project, login proposes
an Ed25519 key kept in the existing owner-only local auth store. Browser approval
records the stable code, one display name and settings. A 30-day bearer sign-in
is a separate generation under that approval. Explicit login always opens the
browser, so switching account still works; accounts have separate approvals for
the same key. Re-login keeps the approved name and settings and always requires the terminal's
typed code, including for remembered or signed-out keys. A request link alone
cannot approve. A new approval, including re-approval after expiry, requires a
browser sign-in or passkey/GitHub check within the existing ten-minute proof
window. The proof is bound to this browser session; token refresh never extends
it. Every approval writes an account notice in the same transaction, and the
device row shows when its last sign-in was issued.

An expired saved sign-in renews through a proof bound to its key, actual HTTP
origin, purpose and operation. Valid commands make no renewal call. A device that has not renewed within 30 days after its sign-in lapses (at most
about 60 days unused) must be approved again; every device is re-approved after
12 months. This is a lapse-based renewal window, not exact last-command
inactivity. Each newly issued sign-in and signed token expires no later than the approval’s twelve-month end; Git also checks the approval boundary. There is no per-command activity write. Both paths return to browser approval and retain
the name and settings. Unknown
outcomes retain the operation locally; an already-settled expired proof is
replaced automatically. Environment-supplied credentials never renew through a
local device key. Sign-out and removal use the central device-end policy:
sign-out retains key/name/settings, while removal revokes the
approval and deletes its display name, settings, public key and code. The same key
can later be approved as a new device. The key on a lost device cannot be erased
remotely. An old bearer or redirected Git sign-in generation cannot regain
access when a later login succeeds.

The existing credential read supplies settings to ordinary authorization.
Current project membership still decides the person's rights; a device only
narrows projects and source writes. Trusted nested source operations check the
same live credential in their existing transaction when no guard projection is
available. Previously authorized jobs and checks retain their existing lifecycle.
Action credential checks retain the existing 30-second isolate reuse bound;
queries and mutations read current state on each invocation. Settings changes
and new sign-in generations have the same thirty-second action-cache bound as
revocation; a cache hit never moves its deadline or extends credential/approval
expiry. Selected-project and read-only settings also refuse account-level writes.
Handle changes and team membership additions require the person on the web.

The account screen uses one account query for browsers, passkeys and a device
page. A different-project picker mounts only on request and reads three existing
20-row directories (owned, shared-write and shared-read), each with explicit
paging. The People screen's folded devices use one account-indexed query for the
selected member (25 returned rows, at most 100 rows or 64 KiB scanned), with code,
approval date and state for peers and names through the one visibility policy.
At 1,200 and 2,400 devices, the synthetic member page reads 28 documents / four
ranges / 10,100 bytes and writes nothing. All source bytes remain in R2; public
key bindings, narrow settings and secret-free operation receipts stay in Convex.
Account/key bindings derive an opaque account-specific reference and reuse the
existing credential index. No table, index, heartbeat or scheduled renewal is added. Renewal performs one HTTP request with
two nested mutations, only after sign-in expiry. The first replaces the previous
query and shares the start budget: 120 new starts/renewals per deployment per
minute, one indexed counter read/write, no additional call. A known renewal
reserves and settles its existing auth receipt, pinning issuance and expiry so a lost preparation reply does
not spend another allowance. At 1,200 and 2,400 devices the synthetic renewal reads seven documents / 2,453 bytes and makes four writes / 1,861 bytes; the pinned expiry adds 28 read and write bytes, with no added call or document read. Unknown-key renewals
use that budget too; known operation retries reuse their existing receipt.
The optional “Also sign out all devices” choice on ending other browser sessions
revokes credentials in bounded 100-row account pages in the original transaction
and event-driven continuations; it keeps keys, names and settings and does no idle
work. Later sign-ins are not selected by those continuations. Rollout stays off
until its existing owner-policy and cost review are complete.

Private device labels remain in account-owned credentials. Shared session snapshots contain the stable code and approval metadata only. Session pages resolve permitted current labels by deduplicated credential IDs within their existing bounded query; historical labels are filtered from public replies.

Selected-project device settings guard native Forge project operations and Git serving, and refuse unlinked imported Codescape views (source, graph, export and lifecycle). The owner-approved imported-view policy is centralized with the other access policies. Existing argument/return validators identify unlinked resources at public registration; the source gate also covers string-based requests. The credential projection supplies this decision before business I/O, with no extra RPC or database read. All-project devices keep the existing person/provider checks. Currently no legacy imported view has a native-project association; a future association must be verified on the server before it can satisfy a selected-project grant.
