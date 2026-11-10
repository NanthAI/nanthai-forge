# Import GitHub source into a hosted project

Forge's development app can import a committed GitHub snapshot into a writable
hosted project. GitHub supplies the source; Forge stores it and initializes
hosted `main`. Import, source publication and hosted checks need no Mac owner
process. Your editor and agent can run on any supported machine.

Forge is not published to npm or deployed as a public production service yet.
Use the development app and deployment URL supplied by its operator, and install
the CLI from the source repository you have access to.

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

The first `nforge` run installs advisory Claude Code/Codex hooks for every Lane
and prints changed files plus the exact undo command. To remove Forge hooks and
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
[Git LFS files](operations/github-project-import.md#git-lfs-files)). Git history
is separate. A public upstream produces a public mirror;
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
nforge import --resume OPERATION_UUID   # after an interruption or a rate-limit reset
```

It waits until hosted `main` is ready and prints the project ID, pinned commit,
readiness, the next `nforge clone` command and the GitHub API requests the import
made, by who paid for them.

If an import stops, **Resume import** retries the original operation and pinned
commit. Partial source is never selected as main. Acquisition runs in the hosted
backend; there is no local recovery or second source upload. See the
[source-import reference](operations/github-project-import.md) for representation
and retry details.

## Work on a hosted project

Sign in to the deployment supplied by the operator, then clone the copied project
URL into a new directory. Replace the example URLs and path with your values.

```sh
nforge login https://YOUR_DEV_DEPLOYMENT.convex.cloud
nforge clone https://YOUR_DEV_APP/alice/project /absolute/path/to/project
nforge agent /absolute/path/to/project start '{"outcome":"Improve the README"}'
```

The import is already hosted and writable before cloning. Cloning materializes
source for your tools; it is separate from server-side import time. Each start
returns its `laneId` and `result.path`. Edit inside that Lane path. Concurrent
agents start separate Lanes. Keep ROOT and its `.forge-client` sibling together;
the sibling holds bindings, retry journals, cached objects and Lane directories.

```sh
nforge agent LANE_PATH save '{"message":"Improve the README"}'
nforge agent LANE_PATH land --save '{"message":"Improve the README"}'
```

Use the returned operation ID to observe or resume the same landing after a lost
reply. Resolve any reported conflicts in the Lane and retry. If the project's
existing policy requests local preflight, save first, then run
`nforge agent LANE_PATH preflight '{}'` before landing.

## No background process

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

A command may start a helper for one job, such as submitting a landing; it ends
with that job (`tests/no-resident-process.test.mjs` lists every such child). The old dogfood owner service (a launchd job on one Mac)
is retired because the hosted queue lands changes
([retired setup](operations/landing-batches.md#owner-mac-launchd-setup-retired)).
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

## Configure the first hosted check

A fresh import has source and Work, but does not infer a check command or install
a GitHub Actions runner. The project owner can inspect existing setup with
`nforge agent ROOT check-settings '{}'`.

For a repository with a README.md, this example defines a small onboarding smoke
check. Replace it with the repository's real verification command for code changes.

```sh
nforge agent ROOT configure-check '{"command":{"name":"verify","executable":"bash","args":["-c","test -s README.md"],"environmentLabel":"README smoke"}}'
nforge agent ROOT configure-runner '{"provider":"github-actions","repository":"OWNER/RUNNER_REPOSITORY","runsOn":"ubuntu-latest"}'
nforge agent ROOT check-settings '{}'
```

The runner repository must already have Forge's check workflow and the Forge
GitHub App installed. configure-runner proves that your linked GitHub account
administers or maintains it and records a runner grant that also covers your
later projects; no browser step or operator setting is needed
([runner grants](operations/github-app.md#runner-grants-checks-only)). No npm
publication, production deployment or upstream repository write is needed for
the import itself.

New projects use the supervised acceptance policy. A checked Lane waiting for
review has not landed: open its Candidate in the hosted app, inspect the change
and check result, and choose **Accept into main** as a person. An existing trusted
project instead follows its configured agent acceptance policy. No local server
is involved. See the [agent workflow](agents/workflow.md) for retries, concurrent
Lanes and acceptance receipts.

## Glossary

| Term | Meaning | UI label? |
| --- | --- | --- |
| Intent | The outcome someone wants; groups related work. | Yes. |
| Lane | One contributor's isolated working directory and saved source history. | Yes. |
| Candidate (formerly View) | An exact pinned combination of Lane heads for checks and review. | Yes. |
| Channel | A named pointer to accepted source, usually main. | Yes. |
| Check | A configured command; a run records its result against an exact Candidate. | Yes. |
| Now | The activity screen showing current work and observed agent presence. | Navigation. |
| Needs you | Work or messages needing your attention. | UI label. |
