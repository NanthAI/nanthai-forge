# Journey 16: an outside contributor to a public project

> Superseded: contributions go through a hosted clone and a Lane; plain Git clone and fetch are a read/export path that needs a Forge sign-in, including for public projects; see [CONTRIBUTING](../../../CONTRIBUTING.md) and [Git serving](../../git-serving.md#access). Findings below are the walkthrough as recorded.

A person or agent with no role on a public project: find it, read it, clone it, propose a change, and the maintainer's side of receiving that change. It also covers discovering and starring projects, forks, and what a maintainer of a busy public project needs.

Walked: the governance doc, the workflows doc (contributor proposals, Home, outside contributions), the Git serving doc, the CI status and GitHub App docs, the proposals, sharing, public imports and Home sources, CONTRIBUTING.md and the open Issues b0ab4cd3, d1303286 and b6588425. **Not walked:** a signed-out visit, a clone, a proposal upload and a pull request on the mirror.

## Steps today

### The outsider

| # | Step | What happens | Evidence |
| --- | --- | --- | --- |
| 1 | Discover a project | No directory, search or explore page for Forge projects was found. The signed-in Projects page lists "Yours, Shared with you, Starred and GitHub". A page "Recent public imports" lists read-only analyses of public GitHub repositories with "Source, license & access check". | source, docs |
| 2 | Read it | A public project has a readable URL, `/HANDLE/PROJECT-SLUG`. "Signed-in stranger / reader: Read public source and Work." Public readers "see no person field at all". Live counts for a public project are five numbers (active agents, subagents, people, Lanes, unannounced Lanes) and nothing else. | docs |
| 3 | Star it | "Hosted-project stars are stored per account in the current browser". | docs |
| 4 | Clone it | `git clone https://DEPLOYMENT/git/HANDLE/SLUG.git`: "anyone can clone and fetch, without signing in". `nforge clone PROJECT_URL DIR` needs a sign-in. Superseded: cloning needs a sign-in on every project, see [Git serving: Access](../../git-serving.md#access). | docs |
| 5 | Try to work in it | A reader "cannot start, save, compose, sync, finish, register a project runner or upload a proposal to this project". `AUTH_SCOPE_DENIED`: "the account lacks access to this project; ask its owner for access." | docs, ran: help |
| 6 | Propose a change, Forge route | Only after the owner invites them as a contributor. Then either hosted Lanes like any contributor, or the Contributions page: "Send changes from your computer" asks for "a full native source and Work archive". That archive came from the removed native mode (journey 11, J11-1). | docs, source |
| 7 | Propose a change, GitHub route | CONTRIBUTING.md: "GitHub main is a read-only mirror of accepted Forge source." On a two-way project a pull request into the mirror's `main` gets a check-only run; a pull request from a fork waits: "Fork PR: a project owner must approve this run." If GitHub merges it, it comes back as a Forge landing by agent `github-inbound`. | docs |
| 8 | Report a bug | No route in Forge. Planning writes need project write access. On an analysis import, "Report an upstream issue" opens an email draft. | source |
| 9 | Fork | Not built. Open Issue d1303286 ("a fork knows its upstream project"). Importing the project's GitHub mirror creates a separate project with no link back. | docs |

### The maintainer

[Journey 32](32-maintaining-open-source.md) maps the maintainer of a busy project in full; [journey 31](31-discover-and-star.md) maps discovery and stars.

| # | Step | What happens | Evidence |
| --- | --- | --- | --- |
| 1 | Make a project public | `nforge host ROOT --visibility public`, or inherited from a public GitHub upstream at import. Settings → General "shows owner, visibility and creation date". | ran: help, docs |
| 2 | Protect what matters | A default owner-approval list applies on every project (`.github/**`, `scripts/forge-check.mjs`, `.forge/**`, `forge.config.*`, `netlify.toml`, `scripts/deploy*`). On a public project it "also applies to contributor persons". | docs |
| 3 | Receive a proposal | Contributions: "No outside contributors or proposals yet." A proposal "is visible, including its contents, to everyone who can read the project, like a pull request. It moves nothing." The owner "downloads it and runs `import-native-contribution`". | docs, source |
| 4 | Run an outsider's change through CI | On a project that uses its own CI file, an outsider's Candidate "settles `runner-unavailable` … and needs a check on Forge's own runner", because "the workflow runs with the mirror repository's secrets". A fork run "never gets private submodule access". | docs |
| 5 | Triage, labels, good first issues, spam | Not built. Planned limits: "at most 5 open proposals per outside account per project; owner switch to turn proposals off" (owner decision on b0ab4cd3). Abuse reports, account suspension and a team-only board are open Issue b6588425. | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J16-1 | S1 | **An outsider cannot propose a change through Forge.** The only Forge route needs an invitation first, which makes the person a contributor, not an outsider. The uninvited route is a pull request on the GitHub mirror, and only if the project turned two-way on. For an open-source GitHub replacement this is the central missing journey. | docs, source |
| J16-2 | S1 | **The web proposal route depends on a removed mode.** "Send changes from your computer" asks for a native source and Work archive, and the maintainer's side names `import-native-contribution`. The CLI no longer produces that archive (journey 11, J11-1). The route is a dead end for both sides. | source, docs |
| J16-3 | S1 | **There is no way to report a bug to a project.** A public project has no place where a reader can write. Planning is for members. | source, docs |
| J16-4 | S2 | **Projects cannot be discovered.** No explore page, no search across public projects, no profile page listing a person's public projects was found. Stars live in one browser, so they are not a signal and do not follow the person. | docs, source |
| J16-5 | S2 | **The refusal gives an outsider nowhere to go.** "Ask its owner for access" names no owner and offers no request (journey 7, J7-10). On a public project the helpful reply is the contribution route. | ran: help |
| J16-6 | S2 | **What an anonymous visitor can see is decided and not described.** The owner's decision is "what anonymous visitors can see: like GitHub". Today public readers see source and Work with people removed. Whether Lanes in progress, the board, planning Items and check logs are public is spread over the governance doc, the agents doc and the check settings (`publicLogs`). A maintainer cannot see one list of what is public. | docs |
| J16-7 | S2 | **Contributing through GitHub hides Forge from the contributor.** The pull request gets one status, `forge/verify`. If the change conflicts with Forge main it fails with `GITHUB_PULL_BEHIND`; if the inbound landing later fails, the commit is taken out of GitHub `main` (journey 12, J12-7). The contributor sees GitHub behaving oddly. | docs |
| J16-8 | S2 | **Who pays for an outsider's check is unsettled per route.** Forge's runner: the runner repository's account. Own CI file: refused for outsiders. Fork pull request: runs after the owner's approval. The journeys Issue promises "land it with checks you did not pay for". | docs |
| J16-9 | S2 | **A maintainer has no intake tools.** No labels, templates, assignment, duplicate marking for outside reports, or block. With agents producing changes, the planned flood controls (five open proposals per account) are the only defence, and they are not built. | docs |
| J16-10 | S3 | **CONTRIBUTING.md mixes two eras.** "Use an isolated Lane or the contribution/proposal route" beside "Use `feat/<scope>`, `fix/<scope>` or `docs/<scope>` branches" and "run `npm run verify` before submitting", while AGENTS.md says never to run the full suite locally. Superseded: resolved in [CONTRIBUTING](../../../CONTRIBUTING.md): hosted planning, Lane, save, focused checks, land; the full verify runs on the project runner. | docs |
| J16-11 | S3 | **Three words for the outsider's change.** Proposal (web, docs), contribution (settings page, command), pull request (mirror). | docs, source |

## Dead ends

- Proposing a change without an invitation (J16-1).
- Uploading a proposal archive (J16-2).
- Reporting a bug (J16-3).
- Finding a project without its URL (J16-4).
- Forking.

## Naming and tone

- Governance is written precisely and for operators ("server-authoritative", "person authority", "Channel CAS"). An outside contributor needs four sentences: what you can read, how to propose, who decides, what happens next.
- "Contributor" means an invited member with write access. On GitHub it means anyone who has contributed. With roles owner / write / read, "contributor" is free to mean the outsider.

## What each persona needs

- **Agent, not person:** a reply to its first refused write that says "you have read access; to propose a change, do X". Limits on open proposals stated before it hits them.
- **Person, not agent (outsider):** to find the project, see that it is alive, and send a change in the tool they already use. They will not install a CLI to fix a typo.
- **Person, not agent (maintainer):** one inbox of outside changes with the check result, who sent it and whether an agent wrote it; one switch to pause intake; a way to block an account.

## Questions for the owner

1. What is the outsider's route in the beta: a Forge proposal (a Lane in the outsider's own space that targets the project), a pull request on the mirror, or both?
2. Does an outsider need a Forge account to propose? To report a bug?
3. Is there a public place for bug reports and requests on a project (public Items), and who may write there?
4. Who pays for the check of an outsider's change, and does it always wait for a maintainer first (the fork rule), or only for a first-time contributor?
5. Is there an explore page and public profiles in the beta, and do stars become account-wide and countable?
6. Should "contributor" now mean the outsider, since invited people have the write role?
7. Is the archive proposal route removed now (with the retired commands in open Issue e41b074c)?
