# Journey 12: importing a GitHub repository and migrating from GitHub

Bringing an existing repository to Forge and moving a team's work with it: source, history, issues, CI and people. [Journey 1](01-first-value.md) covers the first import as a step on the way to first value; this file follows the migration to its end. [Journey 11](11-leaving.md) covers the way back.

Walked: the import and new-project sources, `nforge --help`, `help github`, `help host`, the quickstart, the import reference, the GitHub App doc (two-way sync), the Git serving doc, the status doc and the open import Issues. **Not walked:** an import, a mirror connect, a two-way project and a pull request on the mirror (each creates or changes a project).

## Steps today

| # | What moves | Route | What the person or agent sees |
| --- | --- | --- | --- |
| 1 | Source at one commit | Web: Projects → New project → **Import from GitHub**, fields "GitHub repository URL" and "Branch, tag or commit (optional)". CLI: `nforge import OWNER/NAME [--ref REF] [--name NAME]`. | Web: progress "reports files as source is acquired", then the project opens. CLI: one JSON report with `operationId`, `projectId`, `commit`, `phase`, `ready`, file and byte counts, `githubRequests` "by who paid for them" and `next` (the clone command, or the resume command). On t3code (about 29,000 files) two runs took 2 min 31 s and 2 min 37 s. (source, docs) |
| 2 | An interrupted import | **Resume import**, or `nforge import --resume OPERATION_UUID`. | Resumes the same operation and the same commit. "Partial source is never selected as main." (docs) |
| 3 | A private repository | The Forge GitHub App must be installed for that owner and repository. | A refusal names the repository and links to the installation's settings ("add the repository under Repository access, then retry"), or says the App is not installed and names the install step. (docs) |
| 4 | Git history | Stored at import: "GitHub's own pack bytes in R2, same commit ids". | Lane `history` log, blame and file-at-commit reads match GitHub. A plain `git clone` of the project from Forge serves that history plus one commit per landing. The quickstart says only "Git history is separate." (docs) |
| 5 | Large and unusual content | Binary files, executable modes and symlinks are kept. Submodules stay commit pointers. Git LFS files hold their bytes, up to 1 GiB of LFS objects per import. | A path that is not valid UTF-8 refuses the import with `GITHUB_SOURCE_UNSUPPORTED` and the fix ("rename them in Git to UTF-8 names, push, and retry"). A repository above the size limits (56,800 files per State for sync) is refused later, at the first operation that exceeds them, with `SOURCE_STATE_TOO_LARGE` and "split the repository". (docs) |
| 6 | Visibility | Follows the upstream: "A public upstream produces a public mirror; a private upstream retains private visibility". | No choice is offered at import. (docs) |
| 7 | CI | Nothing is imported. "A fresh import has source and Work, but does not infer a check command or install a GitHub Actions runner." | The owner defines a check command and a runner by hand. See [journey 13](13-connecting-ci.md). (docs) |
| 8 | Issues and pull requests | Source import leaves them at the origin. Separate agent planning transfer prepares a source-agnostic backlog; apply is staged default off. | Original status, dates and source are retained. Integrated web review, look-alike merge and import Undo remain open. Pull-request work stays at the origin. (source, docs, synthetic tests) |
| 9 | People | Nothing is imported. | The owner invites each teammate by handle or email. See [journey 7](07-people-access.md). (docs) |
| 10 | Keeping GitHub current during the move | `nforge github connect PROJECT --repo OWNER/NAME` turns on the mirror; every landing pushes one commit. | See [journey 11](11-leaving.md). An empty GitHub repository now gets its first commit automatically; a very large import still needs one manual first push (open Issue 5bc16ea7). (docs) |
| 11 | People who still push to GitHub | Two-way: policy `githubMirror.inbound:true`. A push or merge on GitHub `main` "comes back in as an ordinary Forge landing and passes the same checks and review rules", attributed to the owner as agent `github-inbound`. | If that landing fails, `GITHUB_INBOUND_FAILED`; "the next Forge landing publishes Forge main over the GitHub commit, and its commit message says which GitHub commit it takes out. Fix and land that Lane to bring the change back." Limits: 500 changed directories and 5,000 changed files per push. (docs) |
| 12 | Pull requests on the mirror | A pull request into `main` gets a check-only run and a `forge/verify` status. Nothing lands until GitHub merges it. | A pull request from a fork waits for the owner: "Fork PR: a project owner must approve this run." (docs) |
| 13 | A local folder that is not on GitHub | `nforge host ROOT [--name NAME] [--visibility private or public]`. | Not walked. A 29,000-file folder exceeded a 20-second budget and reported `WORK_GIT_FAILED` (open Issue 2abda01f). |
| 14 | Switching GitHub off | `nforge github disconnect PROJECT`. | No web control (journey 11, step 9). |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J12-1 | S1 | **Migration scope is documented; the integrated ledger remains open.** Source and separate Git history acquisition are distinguished from work at the origin. Staged aggregate counts and the CLI scope report preserve unknown counts; web rendering and live qualification remain open. A team finds out one missing thing at a time. | source, docs |
| J12-2 | S1 | **Backlog import is staged.** Agents prepare source-agnostic history through existing planning commands; apply is default off. Web review, look-alike merge and exact-additions Undo are still tracked on the import Item. Source import itself does not migrate tracker work. | source, docs |
| J12-3 | S2 | **"Git history is separate" hides a strength.** The full history is kept with the same commit ids, and blame matches GitHub. The quickstart's four words read as "history is lost". | docs |
| J12-4 | S2 | **Branches and tags other than the one imported are not mentioned.** The import pins one commit. Nothing says what happens to other branches, to open pull request branches or to tags. Forge has Lanes instead of branches, so the answer needs saying. | docs |
| J12-5 | S2 | **Visibility is inherited, not chosen.** A person importing their own public repository to try Forge in private cannot. A public upstream "produces a public mirror". | docs |
| J12-6 | S2 | **A size refusal can arrive after the import succeeded.** The limits apply per operation (save, compose, sync). A repository between the save limit and the sync limit imports and saves, then refuses its first sync. The import report shows file counts but does not compare them with the limits. | docs |
| J12-7 | S2 | **A failed inbound landing removes the change from GitHub `main`.** This follows from "Forge still owns main", and the commit message says so. The person who merged on GitHub learns of it from a commit message on the next unrelated landing, and from a mirror status page. | docs |
| J12-8 | S2 | **Two-way has no name on the web and no switch.** It is a policy field (`inbound`) set through `set-policy`, or a default of `nforge github connect`. The web's GitHub page (journey 11) does not say whether pushes to GitHub come back. | docs, source |
| J12-9 | S2 | **A public repository cannot be imported by an account with no GitHub sign-in.** The import fails "with a private-repo error" (open Issue 2abda01f). The planned move to passkeys (de67c77d) makes accounts without GitHub the normal case. | docs |
| J12-10 | S2 | **The order of a safe migration is not written down.** Import, define the check, connect the mirror, turn two-way on, invite people, tell them to stop pushing to GitHub, switch two-way off. Each step is documented in a different file (quickstart, GitHub App doc, governance doc). | docs |
| J12-11 | S3 | **The import report is JSON only.** A person at a terminal gets `githubRequests` and `phase` fields. The same pattern as journey 2 (replies are built for agents). | docs |
| J12-12 | S3 | **Two imports with nearly the same name** (journey 1, J1-10): the editable import and "Import from GitHub · read-only analysis". | docs |
| J12-13 | S3 | **Two docs disagree on plain Git.** The Git serving doc describes `git clone` and `git fetch` from Forge as working, with imported history. The status doc says "plain `git clone` of that history from Forge waits on hosted Git serving (Issue 09367fb2)". A migrating team reading both cannot tell whether their Git tools will keep working. Not walked. | docs |

## Dead ends

- Integrated backlog review and import Undo remain open; pull-request work stays at the origin.
- Importing a public repository as a private project.
- An account with no GitHub link importing a public repository (J12-9).
- A repository above the limits: "split the repository" is the only next step.

## Naming and tone

- "Import" (web, CLI), "acquisition" (docs), "seed" and "bootstrap" (`nforge host`), "adopt" (`github-sync`) all describe bringing source in.
- "Mirror", "two-way", "inbound", "sync" and "publish" describe the link afterwards. The owner's decision is **mirror**; two-way needs a word that fits beside it.
- The refusals for a private repository are a model: they name the repository, the cause and the page to open.

## What each persona needs

- **Agent, not person:** one command that imports and returns the clone command (present); the resume command in the reply (present); the size limits in the reply before it starts work that will hit them.
- **Person, not agent:** a migration checklist with what comes across and what does not; a choice of visibility; proof that history and blame survived; a clear statement of who may still push to GitHub and what happens when they do.

## Questions for the owner

1. Decided: agents read authorized source exports or APIs and recreate backlog through the source-agnostic planning path. Built-in tracker connectors and ongoing two-way tracker synchronization are outside the current scope.
2. What is the promise for open pull requests at the time of the move: finish them on GitHub through two-way, or re-create them as Lanes?
3. May a person choose private when importing a public repository?
4. What is two-way called beside "mirror", and is it on by default when a mirror is connected (today `nforge github connect` turns it on)?
5. Should the import report compare the repository with the size limits and warn before the first refusal?
6. Do tags and release notes come across (see [journey 19](19-releases.md))?

## Migration ledger and backlog transfer

The source import and [migration ledger](../../operations/github-project-import.md#migration-scope) distinguish
selected source, separate Git history acquisition and work that stays at the origin. The staged collector uses
one aggregate metadata batch, keeps unknown counts not reported, and retains the operation, ref and exact commit
on failure or resume. The CLI report carries the same ledger and a readable scope sentence. The collection
setting is default off; live qualification and web ledger rendering remain open.

[Backlog transfer](../../planning.md#backlog-import) is source-agnostic: an authorized agent reads milestone docs
or an authorized Issue export/API and prepares rows with original dates, final status, source and public handles.
Preparation writes no planning. Apply is staged default off; it uses existing planning authority and stable source
keys, keeps closed history closed and never creates a landing. The integrated web review, look-alike merge and
exact-additions Undo for the agreed 30 days remain open. There is no ongoing tracker synchronization or imported
pull-request work.
