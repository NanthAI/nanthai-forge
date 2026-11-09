# GitHub App repository bindings

The hosted mirror and Actions runner use Forge's GitHub App. Installation alone
is insufficient: a repository must have an owner-proven binding to the Forge
project, an owner runner grant (checks only), or an explicit deployment operator
override. A numeric GitHub repository ID can have one stored project binding at a
time; any number of owners can hold a runner grant for it.

## Owner setup

These are manual steps for the GitHub App owner and deployment operator:

1. In the GitHub App settings, add the callback URL
   `https://DEPLOYMENT.convex.site/github/oauth/callback`, using the deployment's
   HTTP site origin, not its `.convex.cloud` API origin.
2. Enable user authorization through the App's web authorization flow. This
   implementation uses a separate **Connect GitHub** step. Leave **Request user
   authorization (OAuth) during installation** unchecked (uncheck it if enabled). Installation
   alone does not connect a Forge project. The device flow is unnecessary.
3. Generate a GitHub App client secret. Configure `GITHUB_APP_CLIENT_ID` and
   `GITHUB_APP_CLIENT_SECRET` on that deployment, alongside `GITHUB_APP_ID` and
   `GITHUB_APP_PRIVATE_KEY`. Keep the client secret and private key server-side.
   `CONVEX_SITE_URL` supplies the callback origin.
4. Set the App webhook URL to
   `https://DEPLOYMENT.convex.site/github/webhook` and configure the matching
   `GITHUB_WEBHOOK_SECRET`. Keep the existing workflow-run subscription. GitHub sends installation and
   installation-repository events to Apps automatically; there is no separate
   subscription checkbox for these events. See the
   [event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation_repositories). Check deliveries for `installation` and
   `installation_repositories` when qualifying the setup.
5. Install the App on the selected repositories and approve its permissions:
   Metadata read, Contents and Workflows write for mirroring, Actions write for
   check dispatch.
   The connecting GitHub user must have repository admin or maintain permission,
   and must be a GitHub account linked to the Forge account that runs connect.

See GitHub's [user authorization flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
and [installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

## Connect and inspect

After signing in to Forge:

```sh
nforge github connect PROJECT_ID --url https://DEPLOYMENT.convex.cloud --repo OWNER/NAME
nforge github status PROJECT_ID --url https://DEPLOYMENT.convex.cloud
```

A hosted Lane checkout path can replace `PROJECT_ID` and its `--url` argument.
Without `--repo`, connect uses the configured runner or mirror repository, then
asks in an interactive terminal if neither exists. Only the Forge project owner
can connect or disconnect repositories.

Connect prints the authorize URL and retained operation UUID. Open the URL and
complete GitHub authorization. The CLI waits on that operation through a reactive
subscription, with no polling or scheduled work. Ctrl-C closes the subscription;
it does not cancel a completed binding. Retrying identical parameters reconciles
the same operation. After an authorization failure, use a fresh
`--operation-id UUID` to start again. The OAuth state is bound to the initiating
Forge owner and project, consumed once, and protected with S256 PKCE. Connect
records the GitHub accounts linked to the starting Forge account and makes no
repository or App lookup. The callback completes only when the authorizing GitHub
account is one of them (`GITHUB_ACCOUNT_MISMATCH` otherwise;
`GITHUB_ACCOUNT_REQUIRED` at connect when none is linked), then checks user
admin/maintain permission, finds the App installation, and checks membership in
it. The user token is used in memory once and is never saved or logged.

Installation webhook events refresh imports only for the repositories they name
(at most 1000 per delivery, `INSTALLATION_EVENT_REPOSITORY_LIMIT` in
`convex/sync.ts`), one indexed lookup each; repositories with no imports cause no
write and no scheduled work.

`check-settings` includes the first page of stored bindings with numeric ID,
installation, proving Forge owner, time and active status. `github status`
returns the same binding details and a continuation cursor; use `--cursor` for
subsequent pages. Operator overrides are checked independently and do not appear
as user-proven stored records.

```sh
nforge github disconnect PROJECT_ID --url https://DEPLOYMENT.convex.cloud --repo-id NUMERIC_ID
```

Disconnect removes the stored claim and fences in-flight proof for that
installation. Its operation UUID makes retries safe even after a newer binding.
A different project can then claim the repository with fresh proof.

## Runner grants (checks only)

`configure-runner` needs no browser step and no operator setting. When the
project has neither a stored binding nor an operator pair for the runner
repository, configure-runner proves the caller's access through the App and
records one runner grant per Forge owner and repository (`githubRunnerGrants`,
`convex/githubRunnerGrants.ts`):

1. The identity provider returns the verified GitHub accounts linked to the
   caller's Forge account (one call), as for connect.
2. The App finds its installation on the repository and mints a `metadata: read`
   token for that one repository name. The token stays on the action stack.
3. With that token, Forge reads the repository's numeric ID and canonical name,
   then for each linked account its login (`GET /user/{id}`) and role
   (`collaborators/{login}/permission`). It stops at the first account whose role
   is admin or maintain and whose returned user ID matches; otherwise
   `GITHUB_REPOSITORY_PERMISSION`.

The grant then covers every project the same Forge account owns: their
configure-runner calls re-prove access and refresh the grant, so a lost role is
seen at the next configure. A project moved to another owner loses the old
owner's grant. A grant authorizes only Actions use (dispatch, run lookup,
cancellation, owner-allowed submodule reads). The mirror and enabling
`githubMirror.autoPush` still need a stored project binding.

The one owner step is installing the GitHub App on the runner repository with its
Actions permissions. Several projects share one runner repository safely: each
run is bound by its dispatch response or signed webhook run ID and the OIDC
repository claim, not by repository alone. Their checks run Candidate code with
the runner repository's Actions access, so share a runner only between projects
whose code you trust there.

Cost: configure is one identity call and four or five GitHub calls. Per check
there is no extra Convex call: the mutation that already precedes each Actions
token mint (dispatch reservation, cancellation, lookup, confirmation, submodule
access) reads the grant (two or three indexed reads), and the token is minted by
numeric ID once GitHub confirms the same installation. GitHub refuses an ID the
installation no longer covers. Removal webhooks delete the repository's grants,
uninstall tombstones them, and `nforge github disconnect --repo-id` withdraws the
caller's grant for all of their projects. `check-settings` shows the grant for
the configured runner repository as `runnerGrant`.

## Enforcement and revocation

Every mirror, workflow dispatch and cancellation token goes through the same
binding boundary. Discovery tokens have Metadata read only and contain at most
one page (100) of this project's proven numeric repository IDs. Forge resolves
the requested current name using those tokens, checks the returned ID, then mints
the operation token for that one ID. The binding is rechecked before returning
the token. A rename retains authorization; use the new name when configuring the
runner or mirror. A deleted and recreated repository has a new ID and fails.
GitHub redirects are refused; Forge does not silently follow an old name.

Runner configuration (including direct settings calls) and enabling `set-policy`
`githubMirror.autoPush` require the binding too. Disabling a mirror and unrelated
policy edits remain available after revocation. Settings use retained names; a successful
App preflight refreshes a renamed binding's name. Token minting independently
checks numeric identity before any repository write.

Signed removal events delete the affected claims in 100-ID pages; uninstall
records one installation tombstone, without scanning projects or bindings.
Duplicate deliveries are inert. In-flight proof is fenced against installation
changes. GitHub also refuses token issuance when the App or repository access
has been removed. Already issued tokens cannot be recalled by removing a Forge
binding; the next mint is refused. GitHub permissions and webhook delivery still
need operational qualification.

## What the App can push, and when

The App never holds a standing credential. Each operation mints a short-lived
installation token for one repository and discards it
(`convex/githubAppToken.ts`, `installationToken`). GitHub caps a token at the
permissions the installation accepted: Metadata read, Contents write, Workflows
write, Actions write. The App's permission set is configured in GitHub's App settings, not in
this repository, so the table shows what Forge asks of each token.

| Operation | Requested permissions | Trigger | Code |
| --- | --- | --- | --- |
| Binding discovery | `metadata: read`, only the project's proven repository IDs (one page of 100) | Any token mint below, and runner configuration | `githubAppToken.ts` `repositoryScope` |
| Import read | `contents: read`, `metadata: read`, one numeric repository ID | A user starts a project import; each worker run (archive and paged fallback) | `importReadToken`; `projectGithubImport.ts`, `projectGithubImportArchive.ts`, `projectGithubImportWorker.ts` |
| Check dispatch, run lookup, cancel | `actions: write`, `contents: read` | A hosted check on an App runner (dispatch `forge-check.yml` on `main`, list its runs, cancel a run) | `actionsPermissions`; `projectHostedActionsDirect.ts`, `projectHostedActionsWebhook.ts` |
| Runner setup preflight | None minted; reads the installation's accepted permissions | `configure-runner` | `requireInstallationPermissions`; `projectHostedActionsConfigure.ts` |
| Runner grant proof | `metadata: read`, one repository by name; reads its ID and one user's role | `configure-runner` without a stored binding or operator pair | `metadataProbeToken`; `githubRunnerGrants.ts` |
| Mirror push | `contents: write` (Git data API, plus the Git LFS batch API for LFS paths; GitHub adds `metadata: read`), one repository; also `workflows: write` when the step's plan adds, changes or removes a path under `.github/workflows/`, or when no plan exists yet (unverified bootstrap) | One job per accepted landing | `mirrorPermissionsFor`; `projectGithubMirror.ts` `step`, `src/hosted-github-mirror.ts` |
| Two-way read | `contents: read`, one repository | A GitHub `push` webhook to `main` on a two-way project | `inboundReadPermissions`; `projectGithubInboundRun.ts` |

The mirror is the only operation that writes source to GitHub. Check dispatch
writes only Actions state (a workflow run); Forge checks themselves run with
`contents: read` (`.github/workflows/forge-check.yml`) and the workflows in this
repository do not push.

### When the mirror pushes

All of these must hold:

- The project policy has `githubMirror.autoPush: true` for a repository
  (`laneRefs` is fixed `false`). Enabling it needs the stored binding
  (`projectAutonomy.ts`, `requireStoredRepositoryBinding`). Disabling stops
  future jobs without a binding.
- The project's source authority is `server` (hosted). The check is in
  `enqueueGithubMirror` and again when each step starts (`mirrorJob`).
- A landing is accepted onto `main`. The job is created in the same transaction
  as the acceptance (`projectHostedAcceptancePublish.ts`,
  `projectHostedLandingBatchPublish.ts`), one per receipt, run in order with one
  active job per project (`projectGithubMirrorQueue.ts`). There is no timer,
  watcher or idle job.
- The binding is current when the token is minted (`githubBindingStore:requireId`).

### What it pushes

- **Branch:** only `refs/heads/main`, by `PATCH` with `force: false`. Lane refs,
  other branches, tags and deletions are never written.
- **Contents:** blobs, trees and one deterministic commit per accepted State
  (`src/hosted-github-mirror.ts`). It carries the landing message and a
  `Forge-State` trailer.
- **Published like GitHub:** every tracked path, whatever its name (test
  `*.pem`/`*.key` fixtures, `.envrc`, `.npmrc`, `.env.development`). Only Forge
  metadata (`.git`, `.forge`) and Forge's `private-artifacts` stay out
  (`publicationExclusion`, `src/files.ts`). Credentials are caught by content: the
  landing secret scan, and the save check for new files. A mirror commit written
  before this rule dropped such names; the next mirror commit adds them back.
- **Refusals:** the push stops, changes no ref and retains the job when GitHub
  `main` is not the mirror's recorded parent (`GITHUB_SYNC_CHANGED`) or its tree
  differs from the matching State (`GITHUB_SYNC_BOOTSTRAP_TREE`). GitHub's own
  branch protection on `main` also applies to the `PATCH`; a block surfaces as a
  retained `GITHUB_SYNC_API` failure. That last point is GitHub behavior this
  repository does not test.

### Two-way sync

Opt in per project with `githubMirror.inbound: true` (needs `autoPush: true`),
for example `set-policy {"githubMirror":{"repo":"owner/name","autoPush":true,"laneRefs":false,"inbound":true}}`.
Forge still owns `main`: a change merged or pushed on GitHub comes back in as an
ordinary Forge landing and passes the same checks and review rules.

- **Trigger:** the App's `push` webhook for `refs/heads/main`
  (`projectGithubInboundQueue:receive`). A push whose head is the mirror's own last
  commit writes nothing; a one-way project writes nothing. There is no polling.
- **One job per push:** the inbound job shares the mirror queue, so publishes and
  inbound work never race. Pushes that arrive while it waits coalesce into it. A
  publish that finds GitHub `main` moved (`GITHUB_SYNC_CHANGED`) yields to an
  inbound job instead of failing.
- **What comes in:** the job reads GitHub `main`, diffs its tree against the last
  mirrored commit by walking only changed directories, stores the changed bytes
  in R2 (windows of 99 objects, never one Convex call per file), and submits a
  Lane whose base is the accepted State the mirror last matched. Forge composes it
  onto current `main`. The landing is attributed to the project owner as agent
  `github-inbound`, and it claims no owner review bypass: protected paths still
  need their reviewers.
- **Limits:** 500 changed directories and 5,000 changed files per push. Larger
  pushes, unsupported modes, or a path that both GitHub and Forge changed since
  the last mirror fail the job visibly (`GITHUB_INBOUND_TOO_LARGE`,
  `GITHUB_INBOUND_MODE`, `GITHUB_INBOUND_CONFLICT`); nothing is half-applied.
- **When the landing fails** (a check or review blocks it): the Lane is kept, the
  job fails with `GITHUB_INBOUND_FAILED` and the mirror status names the Lane.
  Nothing is held: the next Forge landing publishes Forge `main` over the GitHub
  commit, and its commit message says which GitHub commit it takes out. Fix and
  land that Lane to bring the change back.
- **When it lands:** the GitHub commit becomes the mirror's recorded commit for
  that tree, and the next publish builds on it, so GitHub history is kept.
- **Cost:** idle is zero. One push costs a handful of Convex mutations plus one
  per 99 changed files, and GitHub calls grow with changed directories, not
  repository size.
- **Keeping `main` from diverging** (branch protection that requires the Forge
  check on GitHub) needs the App to hold Commit statuses and Administration write.
  That setup is tracked as a follow-up; until then a direct push to GitHub `main`
  is brought in, or published over with a note, as above.

### Token guard

Every installation token request names an explicit permissions object
(`mirrorPermissions`, `actionsPermissions`, the import read set and the
binding-discovery probe). `mintInstallationToken` refuses a request without one,
and `tests/github-token-permissions.test.mjs` asserts the request body for the
mirror, check and import uses. GitHub refuses a tree that touches
`.github/workflows/` without `workflows: write` (403 on `POST git/trees`), so the
mirror proves the binding, reads the step's plan (retained cursor or a diff of
two States), then mints one token: workflow changes get `workflows: write`, every other step
contents-only. Before an unverified bootstrap has diffed, the paths are unknown
and both are requested; this costs no extra GitHub call.
`tests/hosted-github-mirror-retry.test.mjs` replays the incident (add, change,
remove a workflow; docs-only; other `.github/` paths). A token permission change must be tested against all
of them.

## Operator override

Self-hosters may configure `FORGE_GITHUB_REPO_BINDINGS` as comma-separated
`PROJECT_ID=OWNER/NAME` pairs. It is an additional authorization path: either a
stored proof or an operator-listed pair permits App use. An unset list does not
disable stored bindings. No OAuth client setup is needed for listed pairs.
Project IDs are exact and repository names are case-insensitive.

Overrides deliberately authorize names and survive removal of stored claims.
Unlike stored numeric proof, a listed name also authorizes its replacement if a
repository is deleted and recreated. The operator must remove or update the pair
to revoke it. Use stored proof for multi-user hosting and reserve overrides for
repositories whose project assignment the operator has verified out of band.

This feature adds no idle worker, timer, polling loop, source scan, or storage
backfill. Authorization is evaluated only during requested operations and signed
webhook delivery.
