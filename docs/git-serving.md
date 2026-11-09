# Git serving

Hosted Forge answers plain `git clone`, `git fetch`, `git pull` and `git ls-remote`
over smart HTTP. It is read-only: `git push` is refused with a message that pushes go
through Lanes (`nforge agent ROOT start`, then `land`), which land through the normal
check and queue. Main never changes over Git.

```sh
git clone https://<deployment>.convex.site/git/<handle>/<slug>.git
git clone https://<deployment>.convex.site/git/<projectId>.git   # same project by id
```

`<handle>/<slug>` is the project's web route; `.git` is optional.

## Access

- **Public project:** anyone can clone and fetch, without signing in.
- **Private project:** use a Forge login token (from `nforge login`, scope `cli`) as
  the HTTP password with any username, for example through a Git credential helper,
  or send it as `Authorization: Bearer`. Every request checks the token's stored hash,
  expiry and revocation, then current project access (owner, contributor or reader).
  Past access never grants new access.
- No credentials on a private or unknown project: `401` with a Basic challenge, so Git
  asks for credentials. A signed-in account without access: `404 Repository not found`,
  the same answer as a project that does not exist. A bad, revoked, expired or
  coordination-only token: `401`.

## Refs

Forge lists `HEAD` (a symbolic ref to `refs/heads/main`) and `refs/heads/main` to
everyone who can read the project. `refs/heads/main` is the newest commit Forge stores
Git objects for. When hosted main has landings not yet published as Git commits, a fetch
prints a `remote:` line naming the gap; main is never silently stale.

### Lane refs

Project members (the owner, contributors and readers the project granted) also get one
read-only ref per open Lane: `refs/forge/lanes/<laneId>`. Anonymous readers and signed-in
strangers of a public project never see them.

```sh
git fetch origin refs/forge/lanes/<laneId>:refs/remotes/origin/lane
git diff origin/main...origin/lane     # the Lane's saved change
```

A Lane has no Git commits of its own, so the first fetch that names a Lane makes one for
its saved head and caches it per Lane:

- **Parent:** main's Git commit for the Lane's base (the commit main's GitHub mirror
  published for that State). Forge builds the base tree from the base State and checks it
  equals that commit's tree; otherwise the fetch fails with `GIT_LANE_TREE` and no ref is
  made. A base main has no Git commit yet: `GIT_LANE_BASE_UNPUBLISHED` (sync the Lane or
  retry once the mirror publishes it).
- **Tree:** the saved files, published exactly as the mirror publishes main (Forge
  metadata paths left out, Git LFS paths as pointers, submodules as gitlinks).
- **Author and committer:** the Lane owner's public Forge handle (`handle/agent` when an
  agent saved it) at `<handle>@users.noreply.forge`, at the save time. The message is the
  save message with `Forge-Lane:` and `Forge-State:` trailers. The same saved head always
  gives the same commit id.

A save writes no Git objects. A ref moves only when it is fetched again after a save; a
moved Lane is not listed until a fetch names it. Closed Lanes are not listed. Listings
show the Lanes already built (newest 50) plus the ones named; a fetch names at most 8.

Git sends no credentials while anonymous reads work, as on a public project. A listing
that names a Lane ref answers `401`, so Git retries with the member's token. A plain
`git ls-remote` of a public project stays anonymous; add the token to see Lane refs, for
example `git -c "http.extraHeader=Authorization: Bearer <token>" ls-remote <url>`.

## What is served

The packs are the project's stored Git history: the Git host's own pack bytes in R2
(see [data placement](data-placement.md)), so commit ids equal GitHub's.

- A project imported from GitHub has its history stored at import.
- A project whose main is mirrored to GitHub and has no imported history gets it once
  from the mirror repository on its first Git request, through the same import run and
  history limit (default 1 GiB per project). A public project stores history only from a
  public repository.
- After main's mirror moves, the first ref listing adds one coalesced catch-up pack
  (one fetch per mirror move, not per clone; a two-minute lease stops repeated fetches).
- A project with neither returns `GIT_HISTORY_UNAVAILABLE`.

A clone streams every stored pack from R2 as one pack: a single pack passes through
byte-exact, several are joined under a new header and SHA-1 trailer. A fetch sends the
packs after the newest stored tip the client already has. The client's `index-pack`
verifies every object.

Protocol v2 (`ls-refs`, `fetch`) is the default; v0 clients get a ref advertisement and
a want/have/done fetch. Shallow (`--depth`), partial (`--filter`) and `want-ref` fetches
are refused (`GIT_UNSUPPORTED`).

## Cost and limits

Each HTTP request is one Convex HTTP action and one query that reads the credential,
project, history row, at most 256 pack rows and two small pins; for members also at most
50 built Lane rows with their Lane rows (a listing) or the rows of the wanted commits (a
fetch). A clone is three requests
(six calls), whatever the file or commit count; a fetch with nothing new is two requests
(four calls) and reads nothing from R2. Pack bytes are one presigned R2 GET per 32 MiB
chunk and leave through the HTTP action (Convex data egress). Gzipped request bodies
(Git compresses requests over 1 KiB) cost one extra Node action call to decode, bounded
at 1 MiB. Nothing runs while no one uses Git: no timers, scheduling or polling.

The first fetch of a Lane head adds one build action: one query for the plan, one query
per 100 source objects it reads, one record mutation, and R2 PUTs for the Lane pack (the
commit, plus the trees and blobs its parent lacks) and an alias object (SHA-256 to Git blob
id for the base and head). It reads the bytes of the files the Lane changed. File Git ids
come from the alias object; when it lacks more than 32 of the base's (a project's first
build, or a base far from the last one built), the build reads the history packs from R2
once instead and lists the parent commit's tree from them (only trees are kept: about
1.4 MiB for this repository's 25 MB pack, under 1 s), rather than reading every file. A
scan that finds no such tree, or keeps more than 128 MiB of trees, falls back to reading
the files. Later fetches of the same head read the cached row. A Lane fetch sends history after the newest stored commit the client has,
plus the Lane pack. Into a repository without main, that history can repeat an object of
the Lane pack, which `transfer.fsckObjects` rejects; fetch main first.

A Convex HTTP response is at most 100 MiB. Without the large-pack Worker, a fetch whose pack
is larger returns `GIT_PACK_TOO_LARGE` with its size.

## Large packs

When the clone pack (every stored pack joined) is over that limit and the deployment has a
large-pack Worker (`FORGE_GIT_WORKER_URL`), the ref listing answers `302` to the Worker. Git
prints `warning: redirecting to https://…/gitw/<session>/…` and sends the rest of the
session there. Nothing changes for the user: no extra step, setting or credential.

- **Session.** The redirect carries a signed session (HMAC-SHA256 with a key derived from
  the backend's R2 secret) naming the project, the Forge login's credential id (empty when
  anonymous) and an expiry 5 minutes ahead. It holds no password or token. The Worker
  forwards every request back to the backend's `gitw/` route, which checks the signature and
  then, on every request, the credential row (revoked, expired, scope) and current project
  access, exactly like the direct route. A path segment `unpublished-landings` in the
  redirect says hosted main is ahead of the newest Git commit (this path has no `remote:`
  line). Lane refs are not listed on this route yet: a large project serves main only.
- **Bytes.** On this route the backend speaks protocol v0 without side-band, so the pack is
  raw bytes. For the final fetch it returns a byte plan instead of the pack: the ACK/NAK
  line, the R2 object keys (whole chunks, or ranges that drop each pack's header and
  trailer when several packs are joined) and the trailer. The Worker streams those objects
  from its R2 bucket binding by native piping; its JavaScript never touches pack bytes, so a
  clone fits the Workers Free CPU limit (10 ms). It holds no secret, reads only stored-object
  keys the backend names, at most 900 per fetch, and never a key from the client. The SHA-1
  trailer of a joined set is computed once by the backend (one read of the set's R2 bytes)
  and cached on the history row; a single pack passes through byte-exact.
- **Caps.** Each served pack is counted before any byte flows, per project and for all
  projects per UTC day (`convex/gitServeWorkerStore.ts`): 1,000 packs and 20 GiB per
  project, 10,000 packs and 100 GiB in all. The ref listing checks the same counters before
  redirecting. Past a cap Git prints `GIT_BYTE_LIMIT` with the reset time. Usage rows older
  than 7 days are deleted when their scope is next written.
- **Cost.** Workers Free: $0 (100,000 requests a day; a clone is 2–4 Worker requests). R2
  egress is free; R2 reads are one per 32 MiB chunk, inside R2's included 10 million a month
  at the caps. Per large clone the backend makes 3 HTTP actions, 3 queries and 1 mutation
  (plus 1 more mutation and one read of the pack the first time a joined set is served).
  Nothing runs while no one clones.

### Operating the Worker

The Worker is `src/git-byte-worker.ts`, built to `dist/git-byte-worker.js` with no imports.
Deploy it with the `cf` CLI on the Cloudflare account that holds the deployment's R2 bucket:
a Worker with binding `FORGE_R2` (the bucket, read only in practice) and the plain variable
`FORGE_CONVEX_SITE` (the deployment's `https://NAME.convex.site`), served on its
`workers.dev` route. Then set `FORGE_GIT_WORKER_URL` on the backend to the Worker's origin.
`FORGE_GIT_WORKER_MIN_BYTES` (optional) routes clones at or over that size through the
Worker instead of the 100 MiB default. Unset `FORGE_GIT_WORKER_URL` to turn the path off.
