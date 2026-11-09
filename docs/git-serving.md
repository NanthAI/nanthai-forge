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

Forge lists `HEAD` (a symbolic ref to `refs/heads/main`) and `refs/heads/main`, nothing
else. `refs/heads/main` is the newest commit Forge stores Git objects for. When hosted
main has landings not yet published as Git commits, a fetch prints a `remote:` line
naming the gap; main is never silently stale.

Lane refs are not served yet: a Lane is a Forge State without Git commit objects.
When they are, they will be named `refs/forge/lanes/<laneId>` and listed only to
project members.

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
project, history row, at most 256 pack rows and two small pins. A clone is three requests
(six calls), whatever the file or commit count; a fetch with nothing new is two requests
(four calls) and reads nothing from R2. Pack bytes are one presigned R2 GET per 32 MiB
chunk and leave through the HTTP action (Convex data egress). Gzipped request bodies
(Git compresses requests over 1 KiB) cost one extra Node action call to decode, bounded
at 1 MiB. Nothing runs while no one uses Git: no timers, scheduling or polling.

A Convex HTTP response is at most 100 MiB, so a fetch whose pack is larger returns
`GIT_PACK_TOO_LARGE` with its size. Larger repositories need a byte path outside Convex,
which is not built.
