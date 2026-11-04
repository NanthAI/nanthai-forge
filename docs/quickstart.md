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

## Import from GitHub in the app

1. Sign in to the development app and open **Projects → New project**.
2. Expand **Import from GitHub**. Enter a GitHub repository URL. Optionally enter
   a branch, tag or full commit; leaving it empty selects the default branch.
3. Choose **Import from GitHub**. Progress reports files as source is acquired.
   The app opens the project when its complete hosted `main` is ready.
4. Copy the project's URL for the CLI steps below.

This imports the selected committed snapshot, including binary files, executable
modes and symlink targets. Submodules remain commit pointers. Git history and
external LFS objects are separate. A public upstream produces a public mirror;
a private upstream retains private visibility and needs current GitHub access.
The separate **Import from GitHub · read-only analysis** link opens an analysis
tour; use **New project** for an editable project.

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

The runner repository must already have Forge's check workflow and an authorized
GitHub App binding. The development operator supplies that runner setup. No npm
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
