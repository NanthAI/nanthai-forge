# Design constraints

These rules hold the design together. Break one only with an explicit owner decision.

1. **Standalone.** Forge does not depend on NanthAI:Edge accounts, deployment or runtime.
2. **Source and Work are separate.** Immutable source and analysis stay apart from changing Work and current authorization. Old pins and grants never give new access.
3. **One owner per fact.** The existing source, Work, persistence and authorization owners stay authoritative. Do not add a competing store in a client cache, worker spool or adapter. Before adding a cache, table or journal, name the owner it would duplicate.
4. **Mutations are idempotent.** Every mutation carries a client UUID. After an unknown outcome, replay the same UUID and payload. It returns the original result, never reruns a command and never rewinds a later Channel. A changed payload needs a new UUID. Channel acceptance names the expected previous head.
5. **Pins are exact.** A Candidate or run pins its source, definition and environment. A stale pin fails before any work starts. Later changes never alter a recorded result.
6. **Parsing never executes code.** Checks and agents run locally under the OS account. Managed execution and secret use by arbitrary code do not exist.
7. **Forge identities are the daily format; Git holds the bytes.** A State, Lane, Candidate, run or record is identified by its Forge SHA-256 identity, never by a storage identity. Source file bytes and trees are stored as Git objects and packfiles, which is also the export, publication and GitHub boundary; no separate projection exists. Everything Git cannot model (Work, evidence, edit streams, decisions, analysis) lives in Forge's own packed, collectable store beside it. Existing native States and Git-backed owners stay readable through explicit, reversible migration.
8. **Unknown stays unknown.** Missing analysis edges, unmodelled languages and unreported coverage are never proof of independence. Do not guess a binding or fall back to an outer scope.
9. **History is kept.** No automatic age or count deletion, no quotas and no retention deadlines unless the owner asks. Collection removes only verified unreferenced objects. The owner-approved operational windows below exclude Git/source history, receipts, audit and planning.
10. **Live signals are advisory.** Sessions and messages are never locks, never authorization and never acceptance. Declared readiness is not checked or accepted source.
11. **No sandbox claims.** Do not describe Lanes, worktrees, MCP permissions or scoped grants as confinement.
12. **Hosted stack is fixed for development.** Convex for records, Cloudflare R2 for every byte, Clerk identity, the Forge GitHub App and Netlify hosting. R2 is required on every deployment, self-host included (any S3-compatible bucket through `R2_ENDPOINT`). Convex file storage holds only legacy copies awaiting cleanup ([data placement](data-placement.md)). PostHog is deferred.
13. **No new restrictions without being asked.** Do not add user-facing limits, extra steps, delays, access conditions or retention rules. A review finding does not authorize them.

Constraint 7 was replaced by the owner on 2026-10-25, superseding "Native is the daily format". The [SP1 storage decision](research/sp1-storage.md) records the evidence and implementation order.

## Tried and dropped

Things we built, measured and removed. Each entry says what the numbers were, so the next attempt starts from them. A dropped idea may be tried again only if its "what would have to change" line is true.

### Trees in packs (Issue 676efbc2)

**What we tried.** Store every State a second time as a tree: one content-addressed segment per save holding only the folders on changed paths, each folder a Git tree object kept with the SHA-256 identity of its entries. The flat manifest stayed the authority, so this was a dual write, with a merge reader that rebuilt States from trees. The hope was a save that moves kilobytes instead of the whole file list, and a Git mirror that needs no on-demand conversion.

**The numbers that ended it.** All measured on the built code; Kubernetes (31.7k files) and LLVM (190k files) paths with synthetic contents.

- Bytes: a tree save wrote 14 to 26 kB against a 5.35 MB (31.7k) or 28.9 MB (190k) flat list. That gain was real, and nothing a user or a bill could see at the 4k files of our own project.
- Server cost: above the small-save bound a dual-write save has no file list in hand, so it read the base's whole tree: 5,847 GETs per save at 31.7k files and 15,478 at 190k. That peaked at 1.19 GB, past the 512 MB action limit. Conversion stopped at 20,000 files, so it never ran there.
- Latency: each tree level is one round trip from Convex to R2 (about 230 ms live), and a tree save needs 4 to 6 in sequence. The experiment that passed its kill rule ran in memory and did not count them.
- Readers: any reader that needs the whole list is slower from trees. Checkout at 190k took 2.9 s against 0.6 s flat, and a one-file diff 1.57 s against 0.75 s. Flat already beats Git on every client row (checkout 0.6 s against 1.8 to 3.0 s). The merge reader cut State downloads by 60% and cost 2 to 2.6 times the CPU.

**Why it failed.** A State's identity is the SHA-256 of its flat manifest (constraint 7). Every new State therefore needs the whole list in memory, with or without trees; a cheap tree save is reachable only if State identity changes. The flat manifest can never be deleted, only demoted, so trees added a second format to keep in step with the first and a self-heal path for chains that broke, and paid for it on every save.

**What would have to change.** An identity change: a State named by the root of its tree, so a save needs only the folders it touches. That touches every row and receipt that names a State, and needs the client protocol, conversion above 20k files and a migration. It is worth trying only for a repository large enough that flat State bytes dominate the bill (about $31 per 1,000 landings at 190k files against a target of about $2 for everything).

**What replaced it.** Flat States stay. The follow-up is to store large flat States in chunks, with the existing recipe format, so a save uploads only what changed: Issue 2f4e04ad, also dropped (next entry).

### Chunked flat States (Issue 2f4e04ad)

**What we tried.** Keep the flat manifest and its SHA-256 identity, but upload States over 4 MiB as a recipe: content-defined chunks (64 KiB to 1 MiB, the existing object recipe format), with forced cuts around the file list so the parents and message at each end stay out of the stable chunks. A save sent only the chunks its base did not have; a merge read its inputs back part by part.

**The numbers that ended it.** Built code, interleaved paired runs, Kubernetes (31.7k files) and LLVM (190k files) paths with synthetic contents; network model 100 ms per request and 50 MB/s.

- Bytes: identical at 4k (no State is that large). At 31.7k a save uploaded 0.96 MB against 5.35 MB (5.6× fewer, mean), and a merge 0.29 MB. At 190k a save uploaded 1.63 MB against 28.9 MB (17.7×), and a merge 0.28 MB.
- Server time: at 4k unchanged. At 31.7k a save cost 91 ms more CPU and a merge about 580 ms more with network time: each recipe level is a sequential describe, sign and GET. At 190k a save broke even with network time and a merge cost 0.25 to 0.76 s more.
- Memory: not better. A State's identity still needs the whole manifest in memory, so peak RSS rose slightly (179 to 204 MiB at 31.7k; 591 to 600 MiB per save and 777 to 798 MiB per merge at 190k). Both formats are past the 512 MB action limit at 190k.
- Client: the download reader walks a recipe one node at a time, about 3 Convex calls per leaf. Reading a State took 50 calls and 7.3 s against 3 calls and 0.67 s flat at 31.7k, and 218 calls and 32 s against 1.7 s at 190k.
- Cost: State bytes per 1,000 landings went from $5.65 to about $1.24 at 31.7k and from $30.5 to about $2.79 at 190k, client calls included; unchanged ($0.49) at 4k.

**Why it failed.** The kill rule needed live memory and latency at 150k+ files within the action limit and no worse than flat, and nothing slower on the client. Chunks cut bytes but not memory, because identity is still the flat manifest, and they added sequential round trips on the server and many more on the client.

**What would have to change.** Two things together. First, one call that signs all of a recipe's leaves (the leaf list on the object row, or a single describe of the whole tree), on the server and in the client reader, so depth costs nothing. Second, a 190k State that fits in an action, which is the memory problem of flat States, not of chunking. With both, the byte saving above is the prize. The faster chunker loop from this experiment (4 to 5 times faster, same boundaries) was kept.

**Current bounded encoding.** Issue 298f9675 supplies a trusted ordered leaf/range
projection in the existing authorized read for both reader families, and copies
leaves directly into the final buffer. Fixed source writers use that path only
inside the existing 1–4 MiB State window, with unchanged identity, path-stable
file-list cuts and verified destination-range reuse. A representation that would
increase uploaded bytes keeps the flat writer. Physical metadata is published in
the existing output commit; legacy recipes retain their reader. This addresses
sequential descriptor calls at this scale. It does not solve the 190k-file flat
manifest memory failure or authorize a State identity change.

## Decisions from 10 November

These decisions record owner-approved scope and the landed implementation. They
add no new retention window, approval step or stack change. Issue links retain
the evidence; read the full item and comments with `nforge agent ROOT planning`
using its id and `reconcile:false`.

### 2026-11-10: operational retention windows

Raw check callback values compact seven days after terminal run completion;
finished source tasks/batches expire seven days after the whole job ends; check
report detail/shards expire after thirty days. Active physical tasks delay input
cleanup. These diagnostic/retry grace periods bound operational exhaust while
keeping callback digest/ID/time receipts, reuse aliases, verdict/proof/source
pins, accepted source/Git ancestry, planning and audit. Superseded/failed derived
generations retire only through existing ownership/pin proofs. One-shot terminal
wakes and bounded idempotent pages stop when complete; legacy catch-up reuses
them. Why: payload copies outlived their execution readers and grew storage.
Source: Issue [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981); [windows and readers](operations/cost-to-serve.md#operational-expiry-and-storage-per-landing).

### 2026-11-10: weekly backups and manual export approval

Keep the existing weekly backup, Monday 03:00 UTC; manual dispatch requires the
lead's OK. Why: each export reads the whole database; three manual exports on
10 November consumed 3.94 GB DB I/O, about 1.31 GB each (measured total, derived
mean). Inventory/cleanup must not launch an export as a shortcut. No workflow or
backup contents changed. Source: Issue [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981);
[backup cadence](operations/cost-to-serve.md#backup-export-cadence).

### 2026-11-10: separate planning and data projection indexes

Route planning roots/history/comments/search fragments to `projectPlanningRecords`,
source/view-file/non-planning payload/comparison rows to `projectWorkDataRecords`,
and general Work to `projectWorkRecords`. Why: planning indexes covered unrelated
rows. Modelled document/index copies per write fall from 19 to core 11 / planning
17 / data 9. The bounded dev copy/cleanup is complete and temporary layout reads,
mirrors/fallbacks and old core planning indexes are removed. No logical collection
or canonical history was dropped. The owner approved a one-time fresh public
generation at cutover: old list/search cursors get `WORK_STALE` and restart;
record partition, Work revision, source and Issue identities stay the same.
Source: Issue [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981); [reader map, model and measured I/O](data-placement.md#work-projection-index-domains).

### 2026-11-10: immutable object descriptors in catalog pages

Move eligible immutable `projectObjects` descriptors into existing sorted
256-entry `projectObjectCatalog` pages. Keep mutable State ancestry/protection,
pending/rotated bindings and small new worker outputs in rows. Compact
`projectObjectReceipts` pins preserve original upload-id, nonce and exact-size
cleanup/retry semantics. Why: seven descriptor indexes and per-file cold lookup
bytes dominate; randomly rewriting dense pages for a few new objects would cost
more. Measured dev migration verified all 38,003 moved digest/size pairs. Fixture
cold 29k-job DB bytes fell 10,226,466 → 2,105,060 at eleven calls; no live billed
saving is claimed. Source: Issue [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981) and Issue [298f9675](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd);
[compaction](operations/storage-compaction.md).

### 2026-11-10: bounded State recipes

The landed follow-up to rejected experiment `2f4e04ad` provides trusted ordered
recipe leaves/ranges in **one existing bounded authorized metadata read**, for
server, CLI/browser and Actions readers. It removes per-level descriptor/signing
rounds, verifies leaves and logical identity, deduplicates bounded parallel reads,
and reuses verified destination ranges. Physical metadata publishes in the
existing commit. Fixed writers use it only in the existing 1–4 MiB State window
when fewer bytes are uploaded; legacy/flat reads remain. Why: sequential healthy
29k saves upload 3.31 → 0.74 MB in fixtures without extra Convex rounds. This
meets the one-bounded-read concern at that scale. The rejected experiment's
190k-file flat-manifest memory failure remains unresolved; neither that scale nor
a State identity change was approved by this slice. Source: Issue [298f9675](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd);
[original experiment](#chunked-flat-states-issue-2f4e04ad) and
[fixture tradeoffs](operations/cost-to-serve.md#landed-fixes-and-fixture-evidence).

### 2026-11-10: reuse checks for identical and ancestry-only main changes

Reuse a full passed check when checked/main/composed shared entries have the
same blobs, modes and deletions and the complete deltas pass the existing risk
rules, or the existing exact-tree proof establishes an ancestry-only change.
Identical entries clear overlap only; they retain global/declared input and
shared-folder risk. Why: equivalent source was paying for another full check;
the identical-overlap fixture falls from 25 discarded passed runner-minutes per
landing to zero. Retain refusal/recheck for genuinely different overlap, changed
tested docs, global risk, missing/corrupt proof, policy or actor ineligibility.
Graph absence is never independence. Six existing pins suffice; no extra calls
or idle work. Source: Issue [1018d0f8](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=1018d0f8-7745-447b-8e83-b2b502bc25fc); live post-deploy smoke/dogfood measurement
remains open.

### 2026-11-10: live GitLab publishing moves to P8

GitLab stays contract-only in P6; live publishing is owned by P8 Issue
[a697aba8](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=a697aba8-5ca4-4e95-af2c-6ce3139700db). Why: it needs owner GitLab access and matters for outside users in
P8. GitHub ci-status shipped LFS publication, mirror-lag retry, Candidate branch
cleanup and superseded-run cancellation; its live/timing evidence is complete
with sample limitations retained. Source: closed Flip 3 Issue [4e4204b6](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4e4204b6-9373-49b3-a8fd-3eb06208a310).
Closed one-client/parity Issue [657d63ee](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=657d63ee-249a-44ae-94e2-55549f84eea9) also includes the accepted State/hash
codemod; it is not an open P6 dependency. P7 is UX and UI only.
