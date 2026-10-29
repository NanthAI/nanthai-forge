# GitHub App repository bindings

The hosted mirror and Actions runner use Forge's GitHub App. Installation alone
is insufficient: a repository must have an owner-proven binding to the Forge
project, or an explicit deployment operator override. A numeric GitHub repository
ID can have one stored project binding at a time.

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
   Metadata read, Contents write for mirroring, Actions write for check dispatch.
   The connecting GitHub user must have repository admin or maintain permission.

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
Forge owner and project, consumed once, and protected with S256 PKCE. The callback
checks user admin/maintain permission and membership in the selected installation.
The user token is used in memory once and is never saved or logged.

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
