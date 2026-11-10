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

**What replaced it.** Flat States stay. The follow-up is to store large flat States in chunks, with the existing recipe format, so a save uploads only what changed: Issue 2f4e04ad.
