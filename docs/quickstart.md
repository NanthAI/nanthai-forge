# From a project to your first landing

Bring a [GitHub repository](#import-from-github-in-the-app) or a [local folder](#host-a-local-folder) to Forge, then make a small change and see it land on hosted `main`.

Forge is not published to npm or deployed as a public production service yet.
For a trial, get account access from the person who invited you. You can build
the CLI and read its packaged guides while you wait for access.

## First landing

1. [Build and link the CLI](#install-the-cli) if you do not have it yet. [Check your terminal sign-in](#sign-in) and sign in if needed.
2. [Import committed GitHub source](#import-from-github-in-the-app), or [host a local folder](#host-a-local-folder). For a new project, start with a folder and a short README.
3. [Clone the hosted project](#clone-the-project). Use the project name shown in the app or the command from the host or import receipt.
4. [Start a Lane](#work-on-a-hosted-project) and edit its README. Run the landing command and follow what it prints. `LANDED` means your change reached main.

For project settings, checks, secrets, teammates and GitHub, see
[Set up your project](guides/set-up-your-project.md). For an agent app that
needs a tool connection, see [Connect over MCP](agents.md#connect-over-mcp).

## What you need installed

Node 24.22.1+ (24.x) is the only supported Node; the CLI refuses others with
`UNSUPPORTED_NODE`. Nothing else is needed for hosted work: no daemon, database,
Docker or browser extension. A browser signs you in and shows the app.

| Path | Node 24.22.1+ | npm | Git | Other |
| --- | --- | --- | --- | --- |
| Install the CLI from source (today; no npm package yet) | yes | yes | yes, to fetch the source checkout | none |
| Hosted work: `login`, `clone`, `start`, `save`, `land`, `wait`, `pull`, `status` | yes (runs the CLI) | no | no | none |
| Import from GitHub in the app (or `nforge import`) | yes for `nforge import`; the app needs only a browser | no | no: the import runs on the server | GitHub account; the Forge GitHub App for private repositories |
| Host a plain directory (`nforge host`) | yes | no | no | none |
| Import from a local clone (`nforge host` on a Git worktree) | yes | no | yes, 2.38 or later | none |
| Mirror `main` to GitHub (`nforge github-sync`) or checks with submodules | yes | no | yes | GitHub access for the mirror |
| Backups | yes | no | no | `tar` and `gzip` |

Once the CLI is installed, hosted work never calls Git. A machine with no Git
on `PATH` can run it after the CLI is installed another way. A git-free install
through a published package comes with npm publishing. That fresh-machine run
with no Git on `PATH` has not been done yet; it joins the new-user walkthrough
(Item adfa4c84-2873-48b0-829f-3da4a6b2a860).

## Install the CLI

Installing from source needs Node 24.22.1+ (24.x), npm and Git ([what you need installed](#what-you-need-installed) says why). In a new directory:

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
stay as they are. Only the installed CLI writes them, and a
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

Run `nforge auth status` to check whether this terminal is signed in. If it is,
continue to hosting or import. Otherwise sign in:

```sh
nforge login
nforge auth status
```

Open the printed link in a browser signed in to Forge, verify the
code and approve your terminal. Return to the terminal for the completed sign-in.
Forge remembers your sign-in and uses the selected instance for unqualified commands. To sign in to a specific instance, run `nforge login --url 'https://forge.example'`. If it expires, run `nforge login` again and
approve the new code.

## Import from GitHub in the app

1. Sign in to Forge and open **Projects → New project**.
2. Expand **Import from GitHub**. Enter a GitHub repository URL. Optionally enter
   a branch, tag or full commit; leaving it empty selects the default branch.
3. Choose **Import from GitHub**. Progress reports files as source is acquired.
   The app opens the project when its complete hosted `main` is ready.
4. Note the project's `OWNER/PROJECT` name for the CLI steps below.

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

Agents and scripts can import from a signed-in CLI:

```sh
nforge import OWNER/REPO --ref v1.2.0 --name REPO
nforge import OWNER/REPO --preview   # what comes across and which limits apply; creates nothing
nforge import OWNER/REPO --private   # a public repository, private here
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
nforge host /absolute/path/to/folder
```

The folder can be a Git worktree or a plain directory. Hosting is private by
default. After Forge selects hosted `main`, run the clone command it prints.
If hosting is interrupted, rerun the same host command to resume its original
operation and pinned snapshot. See [hosting and recovery](workflows.md#hosted-project-and-companion).

## Clone the project

Clone the project into a new directory from the terminal you signed in with.
Use the project's `OWNER/PROJECT` name or the import or host receipt's clone command.

```sh
nforge clone https://forge.example/OWNER/PROJECT /absolute/path/to/project
```

Cloning materializes hosted `main` for your tools. Keep the clone and its
`.forge-client` sibling together. The sibling holds bindings, retry journals,
cached objects and Lane directories.

## Configure the first hosted check

See [Choose how changes are checked](guides/set-up-your-project.md#3-choose-how-changes-are-checked)
for all three options and their setup commands.

## Work on a hosted project

Start in your clone. For a planned change, use [Start a Lane](guides/agents.md#land-it)
with the Item ID. To try an unplanned change:

```sh
nforge agent /absolute/path/to/project start '{"outcome":"Improve the README","model":"unknown"}'
```

Replace `LANE_PATH` with the path returned by `start` and edit inside it.
Concurrent agents start separate Lanes. Land from your Lane. This saves your
edits and runs any configured local checks before submitting them.

```sh
nforge agent LANE_PATH land --save '{"message":"Improve the README"}'
```

Use `nforge agent LANE_PATH save '{"message":"Improve the README"}'` if you want
to keep a checkpoint before you're ready to land.

Keep the operation ID. Run the wait command Forge prints. Run it again
if it times out. If Forge says the landing is held, see
[Approve the first landing](#approve-the-first-landing).

## Approve the first landing

Follow the [held landing steps](guides/set-up-your-project.md#4-choose-who-approves-landings)
if Forge asks a person to review your change.

## No background process

Cloning into an absent or empty directory inside a Lane keeps the clone’s address and replay journal
in its own sibling cache. Immediate `nforge pull` uses that clone without an extra setup step.

A normal user never needs a Forge background process. `login`, `clone`, `start`,
`save`, `land`, `wait`, `pull` and `status` are short commands: each runs, prints
its result and exits. Nothing starts at login or boot, and no service, launchd or
systemd unit, tray app or listener is installed. Git is not needed for these
commands (see [what you need installed](#what-you-need-installed)); they run
without Git on `PATH`. An idle clone sends no calls.

Two things can stay running, both opt-in and each with one job:

- `nforge worker …` runs hosted checks on your own machine when you choose a
  self-hosted runner ([self-hosted runner](operations/self-hosted-runner.md)).
  Stopping it stops only those checks; it does nothing else.
- `nforge mcp …` is the stdio connection your editor or agent harness starts and
  stops with its own session. It is the harness's process, not a Forge daemon.

A command may start a helper for one job. A landing submitter can wait for a
measurement hold to release, then submit the landing and exit. A preflight
supervisor records one run's result and exits even if the initiating shell closes.
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

See [Forge words](guides/set-up-your-project.md#forge-words).
