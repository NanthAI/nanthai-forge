# Journey 1: discovery to first value

From hearing about Forge to a first clone or pull of a project: install the CLI, sign in, create or import a project, check it out.

Walked: the public landing source, `nforge --help`, `nforge docs`, `nforge status`, `nforge auth status`, the quickstart and README. **Not walked:** a fresh install, a first sign-in, project creation and an import (each changes an account or a project).

## Steps today

| # | Step | Person | Agent | What they see |
| --- | --- | --- | --- | --- |
| 1 | Find Forge | Public landing page: "Hand it off. Watch it land." A field takes a public GitHub repository and **Preview with Forge** opens a dry run ("Public repositories · no account needed") with "Your code, as a map", "Who is doing what, now" and "What your agent would get". | README, `docs/`, the generated `/llms.txt`. | source |
| 2 | Install the CLI | Five commands: `git clone` the source repository, `npm ci --ignore-scripts`, `npm run build:core`, `npm link --ignore-scripts`, `nforge --help`. Node 24.22.1+ is required. There is no published package. | Same commands. | docs (quickstart) |
| 3 | First command | The first `nforge` run installs advisory Claude Code and Codex hooks for every Lane and prints the changed files plus the undo command. | Same. | docs |
| 4 | Sign in | `nforge login DEPLOYMENT_URL` prints `Open URL`, `Code: XXXX`, `Approve NAME (scope) in Forge.` and "This device is named device-xxxx. Rename it any time: nforge auth rename NAME". The browser page is titled "Approve a terminal sign-in" and asks "Approve this terminal? Only approve if you just ran nforge login yourself." It shows Access, Lasts ("30 days, or until you revoke it"), Code and Name ("chosen by the terminal, not verified"). | Cannot finish alone: a signed-in person must approve the code in a browser. | source |
| 5 | Pick a handle | Web: "Pick your handle. Collaborators and agents see you by this handle. You can change it later in settings." CLI: "Change your handle on the web: Settings → Account". | n/a | source |
| 6 | Create or import a project | Web: Projects → New project → "Project name" → **Create project**, or expand **Import from GitHub** (URL, optional branch, tag or commit). An empty project says "Your project is ready. main is empty. Add an agent to start work, or import an existing project archive." | `nforge import OWNER/NAME [--ref REF] [--name NAME]`, or `nforge host ROOT` for a local folder. The import waits and prints the project id, the pinned commit and the next `nforge clone` command. | source, docs |
| 7 | First clone | `nforge clone PROJECT_URL DIR`, then `nforge pull` and `nforge status`. Status prints one line: "Forge clone: current with main." | `pull {}` and `status {}` return JSON. | ran |
| 8 | Before the first landing | A fresh import has no check and no runner. The owner runs `x configure-check` and `x configure-runner`; a GitHub Actions runner needs Forge's check workflow and the Forge GitHub App in the runner repository. New projects are supervised: a person opens the Candidate and chooses **Accept into main**. | The agent's first `land --save` stops for that person. | docs |
| 9 | First-run guide on Now | Three steps: "The outcome, in a sentence … It gets its own Lane." (**New Intent**), "Copy the prompt into Claude Code, Codex or any agent. It works in the Lane.", "When the check passes, Needs you asks for one decision." and a link "How Forge works". | n/a | source |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J1-1 | S1 | **No route for an outsider yet.** The CLI is built from source, and `nforge login` needs a deployment address "supplied by its operator"; with no address and no earlier login it refuses with "Provide a deployment URL or set FORGE_DEPLOYMENT_URL." This follows the owner's rule that nothing is published yet, so it is a known gap, not a defect. It still defines the first-run journey: nobody can reach step 4 without the operator. | docs, source |
| J1-2 | S2 | **The help points at the wrong guide.** `nforge --help` opens with "Start here: nforge docs quickstart (offline Git adoption)". The quickstart is "Import GitHub source into a hosted project", and the README describes it as "hosted GitHub import and first acceptance". | ran |
| J1-3 | S2 | **Three different lists of the first ideas to learn.** README: "Four ideas: Intent, Lane, Check, Channel". Concepts: "An agent needs three nouns: Issue, Lane, landing". PRODUCT.md fixes Intent, Lane, save, View, Check, main, accept. The quickstart glossary says "Candidate (formerly View)" while PRODUCT.md says the owner decided to keep "View". | docs |
| J1-4 | S2 | **A long road to the first landing.** Counted from the quickstart: five install commands, sign-in in two places, a handle, a project, a clone, a check definition, a runner (with a GitHub App and a workflow file in a runner repository), then a person's acceptance on the web. Onboarding pattern: value comes before asks, and three to five steps is the ceiling for a setup wizard. Nothing states what counts as "activated". | docs |
| J1-5 | S2 | **The top-level help is one flat list of about 45 commands.** The six a newcomer needs (`login`, `import` or `host`, `clone`, `agent start/save/land`, `pull`, `status`) sit among operator and recovery commands (`hosted-work`, `make-editable`, `coordination`, `mcp-coordination`, `exchange`, `recover`, `maintenance`, `worker`, `cli release-sign`) and index commands that need a Git worktree. | ran |
| J1-6 | S2 | **The empty project points at a retired route.** "Import archive" on the empty project leads to the archive flow of the removed native mode; the export side of that page prints commands the CLI now refuses (see [journey 11](11-leaving.md)). | source, ran |
| J1-7 | S2 | **Three addresses with three shapes.** Sign-in takes a deployment address (`….convex.cloud`), clone takes the app's project URL (`/handle/project`), and plain Git uses a third host (`….convex.site/git/…`). Nothing in the CLI output relates them. | docs |
| J1-8 | S3 | **The first command edits the agent's configuration.** Installing Claude Code and Codex hooks on the first run is disclosed and reversible, but it happens before the person has seen any value and without being asked. Onboarding pattern: an ask at first launch gets reflexive distrust. PRODUCT.md: "Forge never surprises you." | docs |
| J1-9 | S3 | **"Approve" on the sign-in page.** PRODUCT.md bans "approve" in product UI. The page title, the question and the CLI line all use it. See [journey 7](07-people-access.md) for the wider naming problem. | source |
| J1-10 | S3 | **Two imports with nearly the same name.** "Import from GitHub" makes a writable project; "Import from GitHub · read-only analysis" opens an analysis tour. Home then lists hosted projects, GitHub imports, shared projects and shared source together, filtered by Yours, Shared with you, Starred and GitHub. | docs |
| J1-11 | S3 | **The public preview shows a code map, not the product's promise.** The dry run shows files, imports and an example of Now. It cannot show two agents landing in parallel, which is the claim in the headline. | source |

## Dead ends

- An agent cannot sign in by itself. This is deliberate (a person approves each device); the reply does say what to open and what to type.
- A person with no deployment address has nowhere to go from `nforge login`.
- "Import archive" on an empty project (J1-6).

## Naming and tone

- Web: "Preview with Forge", "New Intent", "Approve this terminal?". CLI: "device", "login", "handle". Docs: "development app", "deployment". The same first step is called sign-in (web), login (CLI) and device login (errors).
- The landing and first-run guide use the product voice (plain, present tense). The CLI help uses reference voice with internal terms on the first screen ("retained address", "operator-action").

## What each persona needs

- **Agent, not person:** one copyable block from install to first `start`; the same guide offline (`nforge docs` provides this); every refusal carries `next` and `learn` (it does). An agent needs to be told plainly that sign-in needs a person.
- **Person, not agent:** to see the promise before installing anything; to know what Forge will change on their machine; one place that says "you are set up, here is the first thing to do". The first-run guide covers the last point only after a project exists.

## Decisions

- Activation is sign-up followed by creating, importing or cloning a project. Cloning someone else's public project counts. A landing is not required and there is no gamified checklist (Item 8edd3157).
- `nforge login` is to default to the Forge hosted service; `--url` stays for self-hosting (Item f3f45a41).
- Advisory hooks install on the first command and say so in one line. The [quickstart](../../quickstart.md#install-the-cli) lists the edits and Undo (Items e6f4b0a6 and 7b74e67b).
- A public project leads with its README, with recent landings beside it and the code map one click away (Item 8947a779).
- The core work terms are Item, Lane and landing, as in [concepts](../../concepts.md#core-model).
