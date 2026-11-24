# Import GitHub source into a hosted project

Bring a [GitHub repository](#import-from-github-in-the-app) or a [local folder](#host-a-local-folder) to Forge, then make a small change and see it land on hosted `main`.

Forge is not published to npm or deployed as a public production service yet.
For a development trial, get the app URL, account access and the CLI deployment
URL from the person who invited you. Open the app URL in your browser and pass
the deployment URL to `nforge login`. You can build the CLI and read its packaged
guides while you wait for access.

## Install the development CLI

Use Node 24.22.1+ (24.x), npm and Git. In a new directory:

```sh
git clone https://github.com/NanthAI/nanthai-forge.git
cd nanthai-forge
npm ci --ignore-scripts
npm run build:core
npm link --ignore-scripts
nforge --help
```

This builds and links your source checkout; it does not install a published npm
release. Keep that checkout to update it from GitHub. `nforge docs quickstart`
opens this guide from the installed source.

Managed installs from the hosted Forge source project default to the signed
stable channel once an owner has published a stable State. Forge builders use
`nforge update FORGE_CHECKOUT --channel main` to track accepted main. For CI,
`nforge update FORGE_CHECKOUT --directory CLI_DIR --bin CLI_BIN --pin FULL_FORGE_STATE_HASH`
selects the same signed build on every run until the advertised compatibility
floor passes it. Run `nforge --version` to see the channel and pin.
See [CLI updates](operations/cli-update.md#stable-releases-and-ci-pins).

The first `nforge` run installs advisory Claude Code/Codex hooks for every Lane
and prints changed files plus the exact undo command. It edits two files,
`~/.claude/settings.json` and `~/.codex/hooks.json`, and in each adds two hook
entries: a `PreToolUse` first-write notice for file edits (`Edit`, `Write`,
`MultiEdit`, `NotebookEdit`, `apply_patch`) and a `Stop` turn-end guard. It also
removes an older Forge `UserPromptSubmit` entry. Other settings and other hooks
stay as they are. Only the installed CLI writes them, never a dev build, and a
run leaves alone hooks that point at another valid Forge install. To remove Forge hooks and
persist user off: `nforge x . uninstall-hooks '{}'`; `install-hooks` reverses it.
`nforge settings firstWriteHooks false` disables installed hooks too. For one
project on this machine, use `nforge x ROOT uninstall-hooks '{"scope":"project"}'`.
Hooks never deny edits, fail open within one second and cache each path/session.
Hosted notices use one bounded saved-path query; unsaved edits and shell writes
remain outside coverage. See [hook settings and coverage](agents/workflow.md#overlap-before-the-first-write).

### On Windows

The same commands run in PowerShell or `cmd` with Node 24.22.1+ and Git for Windows.
`scripts/cli-platform-smoke.mjs` checks the core loop on GitHub's `windows-latest`
runner. Forge paths always use `/`. Differences from macOS and Linux:

- **Executable files.** Windows stores no executable bit. A file keeps the mode it was
  recorded with, so editing a script never drops it, but a new file cannot be marked
  executable from Windows (as in Git with `core.fileMode=false`).
- **Symlinks.** Without Developer Mode or administrator rights Windows refuses symlinks.
  Forge then writes a recorded link as a file holding its target, as Git does with
  `core.symlinks=false`, and reads that file back as the link: editing the file changes
  the link target. Dependency folders use junctions, which need no rights.
- **Line endings.** Stored bytes are exactly what Git stores. A checkout follows the
  project's `.gitattributes` the way Git does with its default settings: files marked
  `text` (or `text=auto`) get CRLF on Windows, files marked `eol=crlf` get CRLF everywhere,
  and saving turns their CRLF back into LF. Without such rules, bytes are never converted.
  `core.autocrlf` and other Git settings are not read.
- **Letter case.** Most Windows folders ignore case: a case-only rename saves as a rename,
  but two paths that differ only in case cannot both be checked out.
- **Private files.** Forge's owner-only checks use the user profile's access list, which
  its folders inherit, instead of permission bits.
- Each command reads its process start time through Windows PowerShell 5.1, which adds
  about 0.2 s.

## Sign in

```sh
nforge login DEPLOYMENT_URL
nforge auth status DEPLOYMENT_URL
```

Open the printed link in a browser signed in to the development app, verify the
code and approve your terminal. Return to the terminal for the completed sign-in.
An expired code names the command to request a new one. If a saved device sign-in
expires, run `nforge login DEPLOYMENT_URL` again and approve the new code.

## Import from GitHub in the app

1. Sign in to the development app and open **Projects → New project**.
2. Expand **Import from GitHub**. Enter a GitHub repository URL. Optionally enter
   a branch, tag or full commit; leaving it empty selects the default branch.
3. Choose **Import from GitHub**. Progress reports files as source is acquired.
   The app opens the project when its complete hosted `main` is ready.
4. Copy the project's URL for the CLI steps below.

This imports the selected committed snapshot, including binary files, executable
modes and symlink targets. Submodules remain commit pointers. Git LFS files hold
their object bytes (up to 1 GiB of LFS objects per import by default; see
[Git LFS files](operations/github-project-import.md#git-lfs-files)). The full Git
history comes across too, with the same commit ids. Issues, pull requests, people
and tags stay on GitHub; CI config stays in the repository and keeps working with the
project's own CI. To keep issues, ask an agent to triage the ones worth keeping and
[recreate them as Items](planning.md#recipe-recreate-past-milestones-then-plan-the-next-one).
See [what comes across](operations/github-project-import.md#migration-scope). A public upstream produces a public mirror;
a private upstream retains private visibility and needs current GitHub access.
If the Forge GitHub App is installed for selected repositories only, a private
repository outside that selection is refused with its name and a link to the
installation's settings. Open the link, add the repository under **Repository
access**, then retry the import. If the App is not installed for that owner, the
refusal says so and names the install step. No Forge setting changes.
The separate **Import from GitHub · read-only analysis** link opens an analysis
tour; use **New project** for an editable project.

Agents and scripts import the same way from the CLI, after `nforge login`:

```sh
nforge import https://github.com/OWNER/REPO --ref v1.2.0 --name REPO
nforge import https://github.com/OWNER/REPO --preview   # what comes across and which limits apply; creates nothing
nforge import https://github.com/OWNER/REPO --private   # a public repository, private here
nforge import --resume OPERATION_UUID   # after an interruption
nforge import --resume OPERATION_UUID --at-reset   # rate-limited: Forge resumes at GitHub's reset
```

It waits until hosted `main` is ready and prints the project ID, pinned commit,
readiness, the next `nforge clone` command and the GitHub API requests the import
made, by who paid for them.

If an import stops, **Resume import** retries the original operation and pinned
commit. Partial source is never selected as main. Acquisition runs in the hosted
backend; there is no local recovery or second source upload. See the
[source-import reference](operations/github-project-import.md) for representation
and retry details.

## Host a local folder

To start from a folder with no GitHub repository, put a file such as `README.md`
in it. From the terminal you signed in with, run:

```sh
nforge host /absolute/path/to/folder --deployment DEPLOYMENT_URL
```

The folder can be a Git worktree or a plain directory. Hosting is private by
default. After Forge selects hosted `main`, run the clone command it prints.
If hosting is interrupted, rerun the same host command to resume its original
operation and pinned snapshot. See [hosting and recovery](workflows.md#hosted-project-and-companion).

## Clone the project

Clone the project URL into a new directory from the terminal you signed in with.
Replace `PROJECT_URL` with the copied URL or use the import or host receipt's
clone command.

```sh
nforge clone PROJECT_URL /absolute/path/to/project
```

Cloning materializes hosted `main` for your tools. Keep the clone and its
`.forge-client` sibling together. The sibling holds bindings, retry journals,
cached objects and Lane directories.

## Configure the first hosted check

On the project's **Needs me** page, **Getting started** links to **Settings → Landing and checks** to choose the required check. Bring your own CI; GitHub is not required. **Connect GitHub (optional)** links to the mirror settings if you want to mirror `main` or use a CI file from GitHub Actions, and does not count toward checklist progress.

Use **Skip** on any other step and **Undo** on the same row to restore it. To put the whole checklist away, select **Hide getting started**; restore it from **Needs me → Help → Show getting started**. Forge keeps your choices for that project across devices without changing anyone else's setup or the landing rules. With the checklist hidden, the owner can still choose who approves landings in **Settings → Landing and checks**.

A new project has source but needs a check definition and a runner before the
first checked landing. In the commands below, replace `ROOT` with the path to
your hosted clone. The project owner can inspect existing setup with
`nforge agent ROOT check-settings '{}'`. If a landing reports
`RUNNER_UNAVAILABLE` and check settings say no hosted runner is configured, keep
the saved Lane and have the owner configure a runner before retrying.

For a repository with a README.md, this example defines a small onboarding smoke
check. Replace it with the repository's real verification command for code changes.

```sh
nforge x ROOT configure-check '{"command":{"name":"verify","executable":"bash","args":["-c","test -s README.md"],"environmentLabel":"README smoke"}}'
```

For GitHub Actions, use a runner repository where your linked GitHub account is
an admin or maintainer. Use a prepared runner repository from your operator, or
have the runner repository owner prepare one. For a new runner repository, use
a copy of the operator's Forge source revision on the runner repository's
`main` so `.github/workflows/forge-check.yml` and the runner code match. Enable
Actions there and install the deployment's Forge GitHub App on that repository
with Actions permissions. For a private project, use a private runner to keep
its check logs private.

```sh
nforge x ROOT configure-runner '{"provider":"github-actions","repository":"OWNER/RUNNER_REPOSITORY","runsOn":"ubuntu-latest"}'
nforge agent ROOT check-settings '{}'
```

See [GitHub App dispatch and runner visibility](operations/github-actions-checks.md#convex-dispatch-with-the-github-app)
and [runner grants](operations/github-app.md#runner-grants-checks-only) for setup
and recovery. A project that uses a runner without GitHub needs
[owner-person authentication for self-hosted runner registration](operations/self-hosted-runner.md#registration).
The owner's saved terminal sign-in can configure the first runner, while the
machine needs owner-person authentication when it starts.

## Work on a hosted project

Start in your clone. For a planned change, use [Start a Lane](guides/agents.md#land-it)
with the Item ID. To try an unplanned change:

```sh
nforge agent /absolute/path/to/project start '{"outcome":"Improve the README","model":"unknown"}'
```

Replace `LANE_PATH` with the path returned by `start` and edit inside it.
Concurrent agents start separate Lanes. When a check and runner are ready,
save the Lane:

```sh
nforge agent LANE_PATH save '{"message":"Improve the README"}'
```

If the save is settling, follow its wait command and confirm the save completed.
If the project's policy requests local preflight, run
`nforge agent LANE_PATH preflight '{}'` before landing.

```sh
nforge agent LANE_PATH land --save '{"message":"Improve the README"}'
```

Keep the landing's operation id and follow its wait command through the check and any
[approval](#approve-the-first-landing). Follow the receipt's recovery for
conflicts and interrupted operations.

## Approve the first landing

New projects use supervised acceptance. When the landing is awaiting review,
the agent can run `nforge agent ROOT approve-link '{"operationId":"LANDING_OPERATION_ID"}'`
with the original landing operation id and share the returned link. Open its
Candidate in the hosted app, inspect the change and check result, and choose
**Approve and land** if you have authority to approve it. Follow the original
wait until it reports `LANDED` and an accepted receipt. An existing trusted
project follows its configured agent acceptance policy. See the
[agent workflow](agents/workflow.md) for retries and acceptance receipts.

## No background process

Cloning into an absent or empty directory inside a Lane keeps the clone’s address and replay journal
in its own sibling cache. Immediate `nforge pull` uses that clone without an extra setup step.

A normal user never needs a Forge background process. `login`, `clone`, `start`,
`save`, `land`, `wait`, `pull` and `status` are short commands: each runs, prints
its result and exits. Nothing starts at login or boot, and no service, launchd or
systemd unit, tray app or listener is installed. Git is needed only to fetch the
Forge source checkout when you install from source (above); these commands run
without Git on `PATH`. An idle clone sends no calls.

Two things can stay running, both opt-in and each with one job:

- `nforge worker …` runs hosted checks on your own machine when you choose a
  self-hosted runner ([self-hosted runner](operations/self-hosted-runner.md)).
  Stopping it stops only those checks; it does nothing else.
- `nforge mcp …` is the stdio connection your editor or agent harness starts and
  stops with its own session. It is the harness's process, not a Forge daemon.

A command may start a helper for one job. A landing submitter can wait for a
measurement hold to release, then submit the landing and exit.
`tests/no-resident-process.test.mjs` lists each helper. The old dogfood owner service (a launchd job on one Mac)
is retired because the hosted queue lands changes
(removed with one client mode).
Its remaining code is removed under the cleanup work, not something to run.

## Keep the project folder current

The equivalents of `git pull` and `git status` are:

```sh
nforge pull /absolute/path/to/project
nforge status /absolute/path/to/project
```

Pull refreshes ROOT from Forge main, refuses tracked edits with a Lane next step,
and preserves disjoint ignored output/dependency links. Re-run after interruption
to resume. Agent equivalents: `pull {}` and root `status {}`. No GitHub mirror
read is needed; the installed CLI updater is separate. See the
[refresh and cost reference](operations/source-exchange.md#hosted-main-client-checkout).
In a Lane folder, `nforge agent . status '{"files":true}'` is the `git status` of
your edits, and `nforge x . snapshots '{"restore":"saved","paths":["FILE"]}'` is
`git checkout -- FILE` (undo it with `{"undo":1}`).

## Glossary

| Term | Meaning |
| --- | --- |
| Item | One piece of planned work on the project's Plan. |
| Intent | The outcome someone wants; groups related work. |
| Lane | One contributor's isolated working directory and saved source history. |
| Candidate | An exact pinned combination of Lane heads for checks and review. |
| Check | A configured command; a run records its result against an exact Candidate. |
| Landing | A Candidate that passed its checks and was accepted into main, with a receipt. |
| Channel | A named pointer to accepted source, usually main. |
| Needs me | The project page that lists what waits on you, such as an approval or a failed check. |
