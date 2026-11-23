## Access is checked before retrieval

Project roles (owner, write, read), what each may do and where each check runs are in [project access](../../access.md); one resolver, `convex/projectRole.ts`, reads membership for every check.

Durable source-worker and mirror continuation reads bind legacy Convex file IDs
to a live `projectObjects` owner row before fetching bytes. Foreign, unknown,
removed and unregistered references fail with `SOURCE_REF_UNOWNED`; a cursor
containing an ID does not prove ownership. Old continuations without owner rows
need migration before resumption. This legacy check costs at most one indexed
lookup and one internal query per read. Project-scoped `r2source:` reads retain
their digest/size verification and add no Convex calls.

What the GitHub App can write to a repository, and when, is in [GitHub App](../../operations/github-app.md#what-the-app-can-push-and-when). Each token names explicit permissions; the mirror adds `workflows: write` only to a step whose plan touches `.github/workflows/` (for a burst tip, when a staged commit touched one, when the ref's whole move from GitHub main changes one, or when GitHub main's State is unknown), or to an unverified bootstrap step whose changed paths are not yet known (requesting both there costs no extra GitHub call, while a contents-only token would stop the mirror on a workflow change). Forge sign-in, GitHub App installation and a person's repository entitlement are separate. Every read of private imported source, graph or export checks current policy and current provider entitlement. Policy is rechecked after provider calls. A saved snapshot, an old grant or a download never creates new access.

Paths, counts, search results and relationships derived from source are part of the visibility boundary.

- **Named readers and reader teams** share a whole private import. Both the importer and the reader need current GitHub entitlement.
- **Source Zones and scoped agent grants** expose selected pinned files and a graph built from only those files. The source text can still mention hidden files, so filtering cannot promise that visible code reveals nothing about hidden code.
- **Scoped agent grants** are time-limited bearer tokens. They allow source reads only: no Work writes, execution, documents or secrets. Expiry, revocation and the creator's entitlement are checked on every read. Refreshing never widens scope. A token represents the owner, not a verified process. Grants cannot limit other tools, files, network or spend.
- **Hosted contributors** get whole-project access through their own flow. A contributor can download the full source archive and return a proposal. Contributors may create Intents, and add notes or change status on Intents they created or are assigned. Creator and assignment lookups use authenticated account IDs in the selected Work generation, with original hosted creation events retained as creator evidence; Lane session labels grant no authority. Revoking contributor access or removing an assignment takes effect on the next write, including retries. Proposal list, detail and download reads follow project visibility. They cannot change project policy; Channel acceptance follows the autonomy rules below.
- **Per-member Lanes and landings** follow the GitHub norm: a contributor changes only their own Lanes (save, sync, abandon, complete, reopen, compose into a Candidate), and their own landing submissions and Candidates (submit, cancel). The project owner may act on anyone's; the action is recorded under the owner's own account. An Intent cascade run by a contributor closes only that contributor's Lanes. A decision record names the caller's account (or `account/slug` for the caller's own agent session), never a client-chosen name; a client that knows its session refuses a decision naming another session's slug. Provider log links are https only: any other stored or provider-sent link shows as no link. Forge's own stall and abandon follow-ups keep the authority of the action that started them.

Signed-out in-page reads of a public project share one budget per project (Convex exposes no client address), set in `convex/abuseLimits.ts` (120 calls a minute); over it they fail with `RATE_LIMITED` and a retry time, and signing in avoids it. Signed-out availability is shared across visitors of a project; exhaustion affects that shared audience, while signed-in reads stay independent. New stored objects count against per-object (100 MiB), per-project (50 GiB or 4,000,000 objects) and per-account (100 GiB or 10,000,000 objects) storage quotas in the same file and fail with `QUOTA_EXCEEDED` when a reservation would pass them; nothing from that request is reserved. The read budget costs one point read and one write per signed-out request; the quota costs one point read and one write per upload batch that reserves new objects, plus one more of each when a project's new usage is added to its account total (every 1,000 objects or 256 MiB per counter shard). Snapshot uploads reserve their new physical object bytes against the same project/account quota before signing PUTs. Each new snapshot reservation adds one counter read/write, plus the existing account roll-up when due; an unchanged tree or replay reserves nothing. Nothing runs while idle.

A contributor membership has 300 fresh check operations, 300 compositions and
300 submissions per UTC day. Each operation id charges once in its creation
transaction; a replay still reconciles at the cap, and failed transactions charge
nothing. The counters reset in place on the first operation of a new day. Owners
are exempt. A new contributor operation adds one indexed membership read and one
fixed-size patch; the owner landing path adds no calls, reads or writes, and idle
work schedules nothing. This bounds request counts, not provider bills or CI minutes.
The counts use `min(300 existing board posts/member/day, 50 GiB / 100 MiB) = 300`;
at the $0.002 serving target that is $0.60 per request class/day in target units.

Downloaded data cannot be recalled. GitHub readers of a full repository already have that access independently of Forge.

After GitHub access is lost, an importer can still list and delete their own imports. That cleanup metadata does not allow reading source, graphs, exports or Restore. Permanent deletion removes objects that only that project owned, and keeps shared objects and minimal receipts. It does not purge provider backups or downloaded copies.

Project invitations never perform recipient email lookup at creation and never grant on sign-in. The signed-in invitee explicitly accepts a pending invitation using their account (for a handle) or unique current verified email (for an address). Unverified, cleared, ambiguous and wrong-account bindings cannot accept; a forwarded link grants nothing. Invitations expire after seven days, and ended invitations cannot send again. The person can decline or block an inviter across projects. Device credentials cannot answer for them. Invitation mail has its own off-by-default switch, verified-sender requirement and transactionally checked limits; see [access](../../access.md#invitations).
