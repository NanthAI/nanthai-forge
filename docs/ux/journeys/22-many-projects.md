# Journey 22: several projects at once and cross-repo coordination

A person or an agent working across more than one project: seeing them together, a change that spans two repositories, and agents in different projects that share one model usage allowance. The agent scorecard of Issue a0cf8c22 names "coordinates across repos".

Walked: the Home and project row sources, `nforge --help`, `nforge settings`, `nforge auth status`, the workflows doc (Home), the agents doc and the open Issues 98084923, 1e474c35 and 431c0c9e. **Not walked:** a second project (this mapping had one), so every cross-project statement rests on source and docs.

## Steps today

| # | Step | Person (web) | Agent (CLI) |
| --- | --- | --- | --- |
| 1 | See all projects | Home → **Projects**: one list of "hosted projects, GitHub imports, shared projects and shared source", filters "Yours, Shared with you, Starred and GitHub". Each row: name, role, "N working", a star ("Star in this browser"). "No projects yet." | No list command. `nforge clone PROJECT_URL DIR` needs the URL. |
| 2 | See what needs me everywhere | Home: "N need you across your projects" (a count; it "covers conflicts and can be lower than the panel's"), a **Needs you** block and "Who's working", "Recent across projects". | None. Every read takes one ROOT. |
| 3 | Switch project | Open the row; each project has its own Now, Work, Code, Settings. ⌘K "matches current-project Intents, Lanes, Candidates and … files" only. | Change folder. Each clone and Lane is bound to one project and one service. |
| 4 | Sign in to two services | One browser session per site. | `nforge login URL` per service; credentials "stored per deployment". `nforge auth status` with no address answers for the last login ([journey 20](20-account.md), J20-2). |
| 5 | A change across two repositories | Two Items, two Lanes, two landings, with no link. Submodules are pointers; bumping one is an ordinary save. | The same. No stack across projects, no "land B after A". The board is per project. |
| 6 | Plan across projects | Planning is per project. Initiatives cannot hold Items of two projects. | `planning` takes one ROOT. |
| 7 | Machine-wide settings | n/a | `nforge settings`: `localHeavySlots` ("auto", 3 slots), `clientCacheMaxGB` (2), `autoPruneHours` (3), `installScripts`, `firstWriteHooks`, `landWait`. These apply to every project on the machine. `nforge heavy CMD` queues heavy local commands under one machine-wide limit. (ran) |
| 8 | Shared model usage | Nothing. Open Issue 98084923: coordinate agents "working across projects which consume the same Claude/Codex usage pool, avoiding each independent agent launching from the same stale usage reading". Owner decision: "advisory only (never refuses a launch); the shared pool is one user's own projects first, teams later." | Nothing. |
| 9 | Projects owned by a team or company | Not built ([journey 36](36-organizations-teams.md)). Every project is owned by one account. | n/a |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J22-1 | S2 | **Home counts what needs you and undercounts.** "N need you across your projects" reads fewer records than each project's panel, so it "can be lower … never higher". A person who manages five projects from Home will miss approvals and failed landings (journey 17, J17-4 and J17-5). | docs |
| J22-2 | S2 | **An agent cannot ask "which projects am I in?"** There is no project list read. An agent told "fix this in the API repo and the web repo" has to be given two folders by its person. The scorecard journey "coordinates across repos" has no first step. | ran: help |
| J22-3 | S2 | **A change that spans two repositories has no shape.** Nothing links the two Items, orders the two landings, or tells the second Lane that the first landed. With a submodule the order is forced (land the library, then bump the pointer) and Forge does not know the two are related. | docs |
| J22-4 | S2 | **Search and the inbox stop at the project boundary.** ⌘K and Needs you are per project. A person looking for "that Lane about login" must remember which project. | docs |
| J22-5 | S2 | **Shared usage limits are invisible.** Agents in different projects under one account draw on the same model allowance and the same CI concurrency (`concurrencyBudget:12` is per project; a GitHub account's job limit is shared). Nothing shows a person the total, and each agent plans as if alone. | ran, docs |
| J22-6 | S2 | **Two services means two of everything.** A person on a company's own Forge and the public one signs in twice, has two handles, and the CLI's default address is whichever they used last. Nothing in a reply says which service it came from. | ran |
| J22-7 | S3 | **Stars are per browser** (journey 16, J16-4), so "my projects" differs between a laptop and a phone. | source |
| J22-8 | S3 | **Machine-wide settings are not shown per project.** `installScripts true` set for one trusted repository applies to every repository on the machine; the reply that offers it says "accept repository requests on this machine". The scope is stated; the risk for the next project is not. | ran |
| J22-9 | S3 | **The Projects list mixes four kinds of thing** (journey 1, J1-10): editable projects, read-only analyses, shared projects and shared source. | docs |

## Dead ends

- One inbox across projects.
- "Land these two changes together, in two repositories."
- An agent discovering its person's projects.
- One Initiative across two projects.

## Naming and tone

- Project, repository, import, analysis, source, workspace and deployment. A person says "repo".
- "Shared with you" is clear. "Shared source" beside "shared projects" is not.

## What each persona needs

- **Agent, not person:** a way to list the projects it may act in; a way to say "this Lane depends on that landing in another project" and to wait for it; a shared view of what its sibling agents are using.
- **Person, not agent:** one page that shows what needs them in every project, what is moving, and what all their agents are spending; search across projects.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I42:** Read state is kept per account so web, phone and CLI agree.
- **I43:** Home holds one inbox across projects, filterable by project.

## Questions for the owner

1. **Answered in group I:** Home holds one inbox across projects, filterable by project. Exact-count implementation remains required.
2. Does a cross-repository change get a first-class link (one Item, a Lane per project, an order), or is it two Items with a note until Phase 9?
3. May an agent list the projects its person can reach, or only the ones it is pointed at?
4. For shared usage (98084923): what does a person see first, model allowance or CI concurrency, and where?
5. Does an Initiative ever span projects (the grievance research lists cross-repo planning), or does that wait for organizations?
6. Should every CLI reply name the service when more than one is signed in?
