# Contract suites

A fake of an outside system is only as good as its match with the real system. Each such fake
has a contract suite in `tests/contracts/<system>.contract.test.mjs`. Qualified cases run
against the real system and each fake that implements the behavior. A fake helper names its suite on
its second line (`// contract: tests/contracts/<system>.contract.test.mjs`). The audit that set
this up is in [test doubles audit](../research/test-doubles-audit.md#contract-suites-one-per-outside-system).

| Suite | Fake it checks | Real target | Cases |
| --- | --- | --- | --- |
| `r2` | `tests/default-r2.mjs`, `tests/fake-r2.mjs` | R2 test bucket | create-only PUT (412 on repeat), HEAD length and checksum, missing HEAD, GET and `Range` (206), missing GET (404), 100-key list pages with byte totals and continuation, DELETE and repeat DELETE |
| `github` | `tests/github-api-fake.mjs` (also used by `hosted-github-mirror-retry`) | Public scratch repository with the contract GitHub App | contents-read token cannot write (403), contents-only token cannot touch `.github/workflows/` (403, incident 708b6943), workflows token can, fast-forward ref update, non-fast-forward refusal (422), refusal text keeps rate-limit diagnostics and never the token |

The R2 suite installs the default fake's in-memory route for its five storage cases so it can run
even when the test preload leaves existing R2 settings in place. The HTTP fake and the real bucket
also run the two request validation cases:
checksum mismatch (400), and expired or tampered signatures (403). The default fake adds no
live R2 requests.

All targets run the production client code. The R2 suite signs with `convex/r2.ts` and lists with
`convex/r2Operations.ts`. The GitHub suite mints tokens with `convex/githubAppToken.ts` and calls
GitHub through `src/hosted-github-api.ts`. When a contract fails, fix the fake or the production
code.

GitHub's synthetic cases cover workflow dispatch with and without a returned run ID, Actions Link
pagination, check-run import across a page boundary, and LFS batch downloads. Live qualification
for these cases awaits owner-approved scratch App access and seed data. The existing nightly live
target still runs the Git data and installation cases.

## Running

Fake side only, with no settings (about 1 s each). The suites import convex modules whose `src/` imports resolve to `dist/`, so run `npm run build:core` first:

```sh
nforge heavy node --import ./tests/check-runtime.mjs --test --test-concurrency=1 tests/contracts/*.contract.test.mjs
```

The real side runs when its settings are present; otherwise it is reported as skipped. The
nightly workflow `.github/workflows/contracts-nightly.yml` (a protected path, so it lands with
the owner's approval) sets `FORGE_CONTRACT_REQUIRE=r2,github`,
which turns a missing setting into a failure, so a lost secret never passes as a skip. It runs at
04:17 UTC and on manual dispatch, on a free GitHub-hosted runner, from the `contracts`
environment. That environment deploys from `main` only, so forks and pull requests never see its
secrets.

| Setting | Suite | Holds |
| --- | --- | --- |
| `CONTRACT_R2_ACCOUNT_ID` | r2 | Cloudflare account ID |
| `CONTRACT_R2_BUCKET` | r2 | test bucket name |
| `CONTRACT_R2_ACCESS_KEY_ID` | r2 | S3 access key of the bucket-scoped token (the token ID) |
| `CONTRACT_R2_SECRET_ACCESS_KEY` | r2 | S3 secret of that token (SHA-256 of the token value) |
| `CONTRACT_GITHUB_REPO` | github | `OWNER/NAME` of the scratch repository |
| `CONTRACT_GITHUB_APP_ID` | github | contract App ID |
| `CONTRACT_GITHUB_APP_PRIVATE_KEY` | github | contract App private key (PEM) |

## Cost

| Item | Per night |
| --- | --- |
| R2 | about 115 class A operations (PUT, LIST) and 15 class B (GET, HEAD); deletes are free. At list price that is under $0.001, and the objects (a few KB) live seconds. A one-day lifecycle rule removes anything a crashed run leaves. |
| GitHub API | $0: a public repository, about 15 requests on the App's own rate limit. One short-lived branch and a few unreferenced Git objects per run; the run deletes the branch. |
| CI | about 2 minutes on a free GitHub-hosted runner (public repository: $0). |
| Convex | $0: neither suite calls a deployment. |

## Setup

Resource names below are placeholders: `BUCKET`, `TOKEN_NAME`, `ORG/SCRATCH`, `ORG/REPO` (the
repository the nightly workflow runs in) and `CONTRACT_APP`. Never write secrets to a terminal or
log: pass them through stdin or a private file deleted straight afterwards.

1. **R2 bucket.** `cf r2 buckets create --name BUCKET`, then the lifecycle rule:
   `cf r2 buckets lifecycle update BUCKET --force --rules '[{"id":"expire-after-1-day","enabled":true,"conditions":{"prefix":""},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":86400}},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":86400}}}]'`.
2. **Bucket token.** `cf accounts tokens create --name TOKEN_NAME --expires-on DATE --policies @POLICY_FILE > PRIVATE_FILE`.
   The policy grants **Workers R2 Storage Bucket Item Write** on the one resource
   `com.cloudflare.edge.r2.bucket.ACCOUNT_default_BUCKET`, nothing else. The S3 access key is
   the token's `id`; the S3 secret is the SHA-256 hex of its `value`. Derive both into private
   files, set the secrets from them and delete every file. The token expires after one year; a
   new token replaces it the same way.
3. **Environment.** `gh api -X PUT repos/ORG/REPO/environments/contracts` with
   `custom_branch_policies: true`, then a `main` branch policy
   (`gh api -X POST repos/ORG/REPO/environments/contracts/deployment-branch-policies -f name=main -f type=branch`).
4. **Secrets.** `gh secret set NAME -R ORG/REPO --env contracts < PRIVATE_FILE` for each setting.
5. **Scratch repository.** `gh repo create ORG/SCRATCH --public --add-readme --disable-issues --disable-wiki`.
6. **Contract GitHub App** (owner, in the browser; GitHub has no API to create an App). Organization
   settings, Developer settings, GitHub Apps, **New GitHub App**: name `CONTRACT_APP`, homepage the
   repository URL, **Webhook: Active** unchecked, repository permissions **Contents: Read and
   write**, **Workflows: Read and write** (Metadata read is added automatically), nothing else,
   **Only on this account**. Create it, note its App ID, and **Generate a private key** (a `.pem`
   file downloads). Then **Install App**, choose the organization, **Only select repositories**,
   pick `ORG/SCRATCH` alone. Set the secrets from a terminal so the key never passes through
   anyone else:
   `gh secret set CONTRACT_GITHUB_APP_PRIVATE_KEY -R ORG/REPO --env contracts < KEY.pem`,
   `printf APP_ID | gh secret set CONTRACT_GITHUB_APP_ID -R ORG/REPO --env contracts`,
   `printf ORG/SCRATCH | gh secret set CONTRACT_GITHUB_REPO -R ORG/REPO --env contracts`,
   then delete the `.pem`.

   Why a separate App: the dev App is installed on every repository in the organization with
   contents and workflows write, and is the bypass actor on the mirror's protected `main`. Its key
   in a runner secret would let one leaked nightly secret write to every repository. The contract
   App reaches the scratch repository only.

## Teardown

`scripts/contract-teardown.mjs` removes everything above. It is a dry run unless given
`--apply`: it reads what exists and prints what it would delete. With `--apply` it deletes, then
reads each resource again, because a non-interactive `cf` delete that aborts still exits 0.

```sh
node scripts/contract-teardown.mjs --bucket BUCKET --cf-token-name TOKEN_NAME \
  --scratch-repo ORG/SCRATCH --secrets-repo ORG/REPO --app-slug CONTRACT_APP [--apply]
```

It empties and deletes the bucket, deletes the token, deletes the scratch repository (the `gh`
login needs the `delete_repo` scope), and deletes the seven secrets and the `contracts`
environment. Deleting the contract App is an owner step it prints: organization settings,
GitHub Apps, `CONTRACT_APP`, Advanced, **Delete GitHub App**. Remove the nightly workflow in the
same Lane, or its next run fails on the missing secrets.
