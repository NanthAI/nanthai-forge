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
9. **History is kept.** No automatic age or count deletion, no quotas and no retention deadlines unless the owner asks. Collection removes only verified unreferenced objects.
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
