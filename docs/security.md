# Security

Forge is development software. It has no security certification and no production release. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Source is data, execution is not

Capture and analysis read untrusted repository bytes. They never run imports, hooks, manifests or package scripts. Source text, comments, Markdown and provider metadata stay data, including text written to address an agent. Rendered Markdown omits raw HTML and runs no JavaScript.

A check or Playbook runs repository code under your OS account. Lanes, Git worktrees, MCP credentials do not confine the file system, processes, network or other agent tools. There is no sandbox. Checks use the clean environment described below, and logs can contain anything the command prints. Local run records and exit codes are observations. Code with your OS authority can forge them.

### Hosted check authorization

Queueing a hosted check requires current project owner or contributor access and ownership of the selected runner (`runner.actor` must match the caller). Project ownership alone does not authorize queueing on another person's runner. Contributor proposals run on the owner's computer only when that runner's owner queues them. Runner polling and claiming enforce the same ownership rule, including for retained requests created before it was enforced; those requests are not rewritten.

**Private projects run only in private runner repositories, unless the owner accepts public logs.** A GitHub Actions run's logs, test names, paths and printed output are as visible as the repository it runs in, so a private project (any project not marked public, including one imported from a private GitHub repository) never runs checks in a runner repository that is not private; GitHub's `internal` visibility counts as not private. Three points enforce it with the GitHub App access Forge already has, and each refuses with `RUNNER_REPOSITORY_PUBLIC` and both fixes (connect a private runner repository, or the owner's opt-in below): `configure-runner` reads the repository's visibility before saving the setting; each dispatch reuses one visibility read per repository for 5 minutes, then reads GitHub again, and refuses before any workflow starts; and every runner call checks the `repository_visibility` claim GitHub signs into the run's OIDC token, before any plan, source or result is exchanged, so a repository made public after connecting is refused at its next check even inside those 5 minutes. A refused check settles `runner-unavailable` with that reason. The project owner (only the owner; never a member or a coordination-only agent credential) may accept public check logs for a runner with `publicLogs:true` on `configure-runner` ([GitHub Actions checks](operations/github-actions-checks.md)); the acceptance names that one repository, and while it is set every check receipt and runner view says plainly that check logs are public. Public projects and opted-in runners are not checked and make no extra call. Cost: no extra Convex call per check (the read rides the existing dispatch reservation and observation); private projects add one GitHub call per runner repository per 5 minutes.

**Private submodules need the owner's allowlist.** A check gets a read token for a private submodule repository only when the project owner allowed that repository with `configure-runner` `submodules` (owner only; empty by default). Allowing a repository grants every change that reaches a check, from any member or agent who can land one, read access to that repository's contents: the check's own commands can read and print it. On a run whose check logs are public (`publicLogs:true`, or a run repository GitHub's signed OIDC claims do not show as private) a repository is read only when the owner allowed it with `"public-logs"`, because printed content is then public. Anything else is refused with the owner's exact command ([GitHub Actions checks](operations/github-actions-checks.md#submodules-in-checks)).

Only the request's creator, the runner's current owner or the project owner may cancel or update a request, and each must still have current project write access. Revoked contributors and read-only viewers cannot queue, cancel or update checks, including retries. Result updates retain the original request, runner and run pins and terminal-result reconciliation. Reports remain observations rather than execution attestations. The canonical owner listener accepts recheck requests only from the current project owner.

### Clean check environments

Every check, including Playbook steps and event automations, starts with private empty `HOME`/`USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and temporary directories under its private run directory. `TMPDIR`, `TEMP` and `TMP` point there. These directories are removed with the disposable workspace; interrupted or changed workspaces retain them until ordinary check-workspace cleanup. Saved `nforge login`, npmrc and cloud/CLI configuration are not discovered through the user's HOME or XDG paths.

The environment allowlist is `PATH`, `LANG`, locale names matching `^LC_[A-Z_]+$`, `TZ`, `TERM`, and Windows tool lookup settings `SystemRoot`, `WINDIR`, `PATHEXT`. Forge's runtime controls `FORGE_GIT_TIMEOUT_MS`, `FORGE_CHECK_FULL`, `FORGE_CHECK_SCOPED`, `FORGE_MAX_CONCURRENT_CHECKS`, `FORGE_CHECK_QUEUE_DIR`, `FORGE_DISK_WARN_GB` and `FORGE_DISK_BLOCK_GB` are also forwarded. Forge sets `CI=true`, the private directory paths, `npm_config_userconfig` and `npm_config_globalconfig` to private empty configuration locations, and `npm_config_cache` to a dedicated shared content cache at `~/.cache/nanthai-forge/check-npm-cache`. That cache is separate from the user's npm cache and configuration and receives no npmrc auth. Each run also gets transient dedicated caches beside it for other ecosystems, one directory per project (`GOMODCACHE`, `GOCACHE`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `NUGET_PACKAGES`, Maven `-Dmaven.repo.local` via `MAVEN_ARGS`); `CARGO_HOME` and `GRADLE_USER_HOME`, which read executable configuration, are fresh directories inside the run with only the project's downloaded content linked in, so configuration a check writes does not outlive it. Only when present at their default location, the toolchain homes `RUSTUP_HOME`, `PYENV_ROOT`, `MISE_DATA_DIR` and `ASDF_DATA_DIR` are passed too. These hold downloaded packages and installed toolchains, never credentials, are not part of the recorded environment or its fingerprint, and a declared `env` passthrough of the same name overrides them. See [self-hosted runner](operations/self-hosted-runner.md#toolchains-and-caches-in-checks). The paths still identify the runner's home location. Node/npm create their own runtime variables when invoked; ambient `NODE_OPTIONS` and npm configuration are not inherited.

Everything else is absent by default, including `FORGE_AUTH_TOKEN`, `FORGE_AGENT_TOKEN`, other `FORGE_*` credentials, `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*` and `CONVEX_DEPLOY_KEY`. This is an allowlist, so new credential variable names are absent too.

The runner supplies its own `FORGE_CHECK_CHANGES`, `FORGE_CHECK_BASE`, `FORGE_CHECK_HEAD`, `FORGE_CHECK_SELECTION`, for interaction runs `FORGE_CHECK_INTERACTION` and, for a check that declares shards, `FORGE_CHECK_PART` and `FORGE_CHECK_SHARD` (with `_INDEX` and `_TOTAL`). These describe the pinned check input and output paths; they do not inherit ambient values, even when declared for passthrough. Unavailable comparison input leaves the corresponding comparison variables absent. The allowlisted controls above remain ordinary runtime settings, so a clean check is not expected to have zero `FORGE_*` variables.

A check definition may explicitly declare `env: ["NAME"]` and/or `credentials: ["TOKEN_NAME"]`. Both pass exactly those variables from the runner process, including credential variables if explicitly selected; `credentials` labels sensitive passthrough separately. Missing variables stay absent. Explicit selections can override generated defaults, including HOME or npm configuration. Declarations are canonicalized and included in the definition digest. Values are used transiently and are not copied into Work metadata, environment fingerprints or receipts. Definitions and receipts show the names; arbitrary command output may still disclose values. These declarations do not resolve or reveal Secret Objects: those remain available only through their existing controlled broker operations.

Declaring `env: ["HOME"]` restores home-relative access to all files under that HOME; it does not also restore `USERPROFILE`, XDG settings or cloud credential variables. Declaring `credentials: ["AWS_SHARED_CREDENTIALS_FILE"]` instead exposes that configured file path while leaving HOME private and other `AWS_*` variables absent. Neither declaration grants filesystem authority: the process already runs with the user's OS rights.

The same clean environment, with no passthrough, applies to the repository-chosen commands Forge runs on your machine outside a check: the dependency install at `start` (and when a sync changes the lockfile), and every command of a local `preflight` (static checks, the build step, package commands and the test runner). One environment is built per install or preflight run and removed when it ends; it also passes corepack's own home (`COREPACK_HOME`, `~/.cache/node/corepack`) when it exists, so the pnpm and Yarn versions corepack already fetched are not fetched again. A repository's declaration of install scripts (`install.scripts` in `forge.json`, `enableScripts` in `.yarnrc.yml`, a package allowlist) is only a request that `start` shows: scripts run when `start` passes `installScripts:true` or this machine's `installScripts` setting accepts requests ([shareDependencies](parallel-work-defaults.md#sharedependencies)). Local preflight runs a build-tool wrapper the tree commits (`gradlew`, `mvnw`) only when the project declares `"preflight": {"wrappers": true}`; otherwise it runs `gradle` or `mvn` from `PATH`.

Definitions without declarations continue to execute in the clean environment. Failed runs record a value-free “may need env passthrough: X” suggestion listing omitted parent environment names; it is diagnostic, not proof of the failure's cause. Environment fingerprints cover the clean runtime policy and allowlisted settings, not undeclared external inputs or passthrough values.

Clean environment isolation prevents ambient discovery through inherited settings. Repository code still has the user's OS authority: it can read known absolute paths, discover the account home through OS APIs, access other processes or the network, and alter shared cache contents. It cannot be claimed unable to read a credential file by every route. Strong protection from hostile code requires separate OS isolation. Upgrade the local runner to obtain this behavior; older binaries retain their previous execution behavior.

`tests/check-environment.test.mjs` exercises real local checks against synthetic HOME files: SSH keys, AWS configuration, saved Forge/GCloud configuration, npmrc and dotenv files. It verifies default read failures, omitted credential variables, exact-name and HOME/file-path opt-ins, and the known-absolute-path boundary without reading real credentials. Source capture excludes newly encountered `.env.local` files; clean environments do not scrub secrets already retained in source or printed by a command.

Handing a secret to arbitrary code lets that code leak it.

**Hosted Actions checks.** On GitHub-hosted Linux runners each Candidate child runs as a separate unprivileged user (`forge-check`) in a private mount namespace that hides the runner's home except the check's own folders and read-only toolchains, so it cannot read the runner's credentials or the supervisor's environment or use `sudo`. Where that user cannot be set up the check fails setup by name, unless the project owner's runner configuration allows shared mode (`configure-runner` `isolation:"shared"`, for macOS or Windows self-hosted runners); the receipt's `check.isolation` says which mode a landing's check ran in. Independently of that, a hosted Actions pass needs the CI provider's own success record, outputs come only from the planning step and caches are saved only before the check step from downloads that run no repository code. See [what Actions evidence attests](operations/github-actions-checks.md#what-actions-evidence-attests).

## Secret scan at landing

Every hosted landing check scans the paths its composed Candidate changes from the composition base, before project code runs. Forge's own executors do it (the GitHub Actions planning job and self-hosted machine runners), so it works with any configured check command. Paths already on main are not rescanned.

It looks for known credential shapes (private key blocks with a key body, AWS access key ids, GitHub, GitLab, Slack, npm, Google, Anthropic, OpenAI, Convex deployment and SendGrid tokens, live `sk_`/`rk_` keys) and for a random-looking value assigned to a secret-named key (`token`, `secret`, `password`, `api_key`, …; mixed values of at least 24 characters, or random hex/lowercase values of at least 32; non-secret hash assignments still pass). Repeated-character placeholders and documented `…EXAMPLE` values are not findings. Files over 1 MiB and links are skipped; smaller files scan even with NUL bytes. Assignment names and whitespace are bounded, and assignment lines over 8 KiB are skipped.

A finding fails the check like a failing test: the landing stops with `CHECK_FAILED`, and the notice names the file, line, kind and a 16-character fingerprint, never the value. The fingerprint is a salted SHA-256 of path, kind and value. At most 20 findings are listed, with a count of the rest.

Remove a real credential first, and rotate it at its provider: once it reached a Lane save it may be retained.

If a finding is not a secret, override it with an entry in `.forge-secret-allow.json` at the repository root: `{"allow":[{"fingerprint":"…","path":"…","reason":"…"}]}`. An entry needs a non-empty reason and covers only that value in that path. Entries count only from main (the composition base), never from the change under check, so a change cannot allow its own finding: land the entry on its own first, then land the change. A change that adds both a finding and its matching entry still fails, and its notice says so. This file is a root file, so changing it always rechecks in full.

Who sees an override: every landing that adds or edits an entry sends the project owners one alert on the landing alert channel (email or webhook, the same settings as stall alerts), and its receipt carries `secretAllowAdded`. Both name the receipt, the submission, the path, the fingerprint and the reason, never the value; a reason that itself looks like a credential is withheld. An entry that matches a finding added in the same landing is labelled as a self-allow. If the allow file changed but no Forge executor diffed it (a bring-your-own check, an older runner or no check), the receipt and the alert say the entries are unknown. Removing an entry is not an override and sends nothing. Accepted history also records who allowed what, when and why, and the Actions planning log shows how many findings each check allowed from main. Today an override never blocks a landing by itself; `secretAllowReview` in `src/secret-allow.ts` is the hook for a project policy that requires a person for agent-added entries (approvals, Issue 517523cf). To require owner review now, add `.forge-secret-allow.json` to the project's `acceptance.protectedPaths`; Forge's own project does.

The scan is a guard, not a guarantee: it does not see encoded or split values, text in skipped files, history that landed before it, or local (not hosted) checks. A future private-file audience (Issue 6bd7ddb1) will be skipped by one flag (`isPrivate` in `src/secret-scan.ts`); until then every changed file is public to the scan. Cost: no Convex calls, no vendor and nothing when idle; it reads only bytes the check already downloaded (the machine runner reads one extra State manifest for the base; when the change edits the allow file and main has one, both runners may read main's allow file, one small object). A landing that adds or edits an allow entry adds one scheduled alert delivery at publication, computed from the run plan and changed paths publication already reads; other landings add nothing. Each eligible changed file is read once.

## Access is checked before retrieval

Project roles (owner, write, read), what each may do and where each check runs are in [project access](access.md); one resolver, `convex/projectRole.ts`, reads membership for every check.

Durable source-worker and mirror continuation reads bind legacy Convex file IDs
to a live `projectObjects` owner row before fetching bytes. Foreign, unknown,
removed and unregistered references fail with `SOURCE_REF_UNOWNED`; a cursor
containing an ID does not prove ownership. Old continuations without owner rows
need migration before resumption. This legacy check costs at most one indexed
lookup and one internal query per read. Project-scoped `r2source:` reads retain
their digest/size verification and add no Convex calls.

What the GitHub App can write to a repository, and when, is in [GitHub App](operations/github-app.md#what-the-app-can-push-and-when). Each token names explicit permissions; the mirror adds `workflows: write` only to a step whose plan touches `.github/workflows/`, or to an unverified bootstrap step whose changed paths are not yet known (requesting both there costs no extra GitHub call, while a contents-only token would stop the mirror on a workflow change). Forge sign-in, GitHub App installation and a person's repository entitlement are separate. Every read of private imported source, graph or export checks current policy and current provider entitlement. Policy is rechecked after provider calls. A saved snapshot, an old grant or a download never creates new access.

Paths, counts, search results and relationships derived from source are part of the visibility boundary.

- **Named readers and reader teams** share a whole private import. Both the importer and the reader need current GitHub entitlement.
- **Source Zones and scoped agent grants** expose selected pinned files and a graph built from only those files. The source text can still mention hidden files, so filtering cannot promise that visible code reveals nothing about hidden code.
- **Scoped agent grants** are time-limited bearer tokens. They allow source reads only: no Work writes, execution, documents or secrets. Expiry, revocation and the creator's entitlement are checked on every read. Refreshing never widens scope. A token represents the owner, not a verified process. Grants cannot limit other tools, files, network or spend.
- **Hosted contributors** get whole-project access through their own flow. A contributor can download the full source archive and return a proposal. Contributors may create Intents, and add notes or change status on Intents they created or are assigned. Creator and assignment lookups use authenticated account IDs in the selected Work generation, with original hosted creation events retained as creator evidence; Lane session labels grant no authority. Revoking contributor access or removing an assignment takes effect on the next write, including retries. Proposal list, detail and download reads follow project visibility. They cannot change project policy; Channel acceptance follows the autonomy rules below.
- **Per-member Lanes and landings** follow the GitHub norm: a contributor changes only their own Lanes (save, sync, abandon, complete, reopen, compose into a Candidate), their own landing submissions and Candidates (submit, cancel) and the overlap answers for their own Lanes. The project owner may act on anyone's; the action is recorded under the owner's own account. An Intent cascade run by a contributor closes only that contributor's Lanes. An overlap answer from anyone other than the Lane's author or the owner is stored but does not answer the notice. A decision record names the caller's account (or `account/slug` for the caller's own agent session), never a client-chosen name. Forge's own stall and abandon follow-ups keep the authority of the action that started them.

Signed-out in-page reads of a public project share one budget per project (Convex exposes no client address), set in `convex/abuseLimits.ts` (120 calls a minute); over it they fail with `RATE_LIMITED` and a retry time, and signing in avoids it. Signed-out availability is shared across visitors of a project; exhaustion affects that shared audience, while signed-in reads stay independent. New stored objects count against per-object (100 MiB), per-project (50 GiB or 4,000,000 objects) and per-account (100 GiB or 10,000,000 objects) storage quotas in the same file and fail with `QUOTA_EXCEEDED` when a reservation would pass them; nothing from that request is reserved. The read budget costs one point read and one write per signed-out request; the quota costs one point read and one write per upload batch that reserves new objects, plus one more of each when a project's new usage is added to its account total (every 1,000 objects or 256 MiB per counter shard). Snapshot uploads reserve their new physical object bytes against the same project/account quota before signing PUTs. Each new snapshot reservation adds one counter read/write, plus the existing account roll-up when due; an unchanged tree or replay reserves nothing. Nothing runs while idle.

A contributor membership has 300 fresh check operations, 300 compositions and
300 submissions per UTC day. Each operation id charges once in its creation
transaction; a replay still reconciles at the cap, and failed transactions charge
nothing. The counters reset in place on the first operation of a new day. Owners
are exempt. A new contributor operation adds one indexed membership read and one
fixed-size patch; the owner landing path adds no calls, reads or writes, and idle
work schedules nothing. This bounds request counts, not provider bills or CI minutes.
The counts use `min(300 existing board posts/member/day, 50 GiB / 100 MiB) = 300`;
at the $0.002 serving target that is $0.60 per request class/day in target units.

Downloaded data cannot be recalled. GitHub readers of a full repository already have that access independently of Forge.

After GitHub access is lost, an importer can still list and delete their own imports. That cleanup metadata does not allow reading source, graphs, exports or Restore. Permanent deletion removes objects that only that project owned, and keeps shared objects and minimal receipts. It does not purge provider backups or downloaded copies.

Project invitations never perform recipient email lookup at creation and never grant on sign-in. The signed-in invitee explicitly accepts a pending invitation using their account (for a handle) or unique current verified email (for an address). Unverified, cleared, ambiguous and wrong-account bindings cannot accept; a forwarded link grants nothing. Invitations expire after seven days, and ended invitations cannot send again. The person can decline or block an inviter across projects. Device credentials cannot answer for them. Invitation mail has its own off-by-default switch, verified-sender requirement and transactionally checked limits; see [access](access.md#invitations).

## CLI device credentials

Device approval issues a Forge-signed JWT with audience `forge-cli`, not the approving browser's Clerk session JWT. The server stores only code/token hashes plus device metadata, approving subject, scope, expiry and revocation state. The server derives unpredictable device secrets and short user codes from a login nonce under its private key; start retries reconcile without storing plaintext codes. Codes expire after ten minutes. A decision is single-use and bound to its approving account. Redemption is single-use; retries with the same operation ID reconcile the original credential. Polls are spaced five seconds apart; approval lookups/decisions allow ten attempts per account per minute. New login starts default to 120 per minute per deployment (retries of a started login do not count); over the limit, `/auth/device/start` answers HTTP 429 `slow_down` with `Retry-After: 60` and writes nothing. Device names are 1 to 80 characters. Code hash comparisons use constant-time crypto verification.

Device credentials cannot reveal Secret Object plaintext, permanently delete projects, including through account cleanup, or register a machine runner and receive its signing key. The owner person uses the browser for these operations. To delete projects from a terminal, a device prepares a bulk request (`nforge host ROOT --delete-projects …`, at most 100 projects, 30-minute expiry). The request holds the exact frozen list and deletes nothing until the owner person approves it once on the web. Approval re-checks each project and skips any that changed. Device and agent sign-ins cannot approve or retry it, and another account reads it as not found. Copying a browser token into the terminal is not needed or recommended. `nforge host ROOT --delete-project …` calls the same permanent-deletion mutation and is refused with `PROJECT_UNAVAILABLE` when authenticated by `nforge login`, including CLI scope. Existing browser account JWT overrides retain person authority. Existing broker use, names, rotation, grants, reversible trash, account cleanup that does not delete projects and runner operation retain their current access rules. Adding contributors, inviting people and granting reader access from a device credential opens an exact membership approval request, even before the first landing. The owner person grants or declines it on the approve page; a grant applies only that request. A held action returns `PROJECT_UNAVAILABLE` with its approval link and wait command. Retry the original command after the grant to reconcile it. Revoking access remains available to agents. Deploy the membership approval readers and web page first, then the request writer. Set the default-off rollout flag `FORGE_MEMBER_APPROVAL_REQUESTS=1` only after those readers are present. Until then, device membership additions refuse with `PROJECT_UNAVAILABLE`; the owner person can still grant access directly.

CLI credentials expire after 30 days and are revocable from account settings or logout. Existing approvals use browser re-login. A stable device that has not renewed within 30 days after its sign-in lapses (at most about 60 days unused) must be approved again; every device is re-approved after 12 months. This is not exact last-command inactivity and adds no activity write; explicit login still opens the browser. Stable sign-in generations, selected-project scopes and source settings narrow the existing person authority. Sign-out retains the key, name and settings; removal revokes the approval and deletes its display name, settings, public key and code under the approved central policy, allowing later approval of the same key. Every approval writes a next-visit account notice. New or expired approvals require a fresh browser sign-in or a session-bound passkey/GitHub check within ten minutes. Ending other browser sessions offers to sign out all devices too. See [the access contract](access-contract.md#stable-device-approvals). The CLI stores credentials in a user-owned `0600` file; it never prints the token. Windows stores no permission bits: there the file's privacy comes from the user profile's access list. Environment overrides remain available. `FORGE_AUTH_TOKEN` is bound to the origin in `FORGE_DEPLOYMENT_URL`; when that is absent, only the saved default deployment or an origin with a saved login may use it. A checkout cannot select a new token destination. Hosted checkout origins must use HTTPS or HTTP loopback. Every public backend function checks Forge credential revocation, expiry, approving subject and scope. Queries and mutations check on every call. Actions also recheck before returning, but reuse a positive check for up to 30 seconds within one server process, so revocation, settings changes and new sign-in generations reach actions within 30 seconds; reuse never extends its own deadline or credential/approval expiry. Signed credential markers retain these checks while issuer configuration changes. Existing current project, contributor, GitHub and source policies still apply. Coordination-only credentials cannot read source, exchange checkpoints or change hosted Work. A CLI credential is bearer authority for the selected scope, not a process identity or sandbox. Self-revocation can be retried after revocation and cannot grant access.

New public Convex functions must use `convex/cliServer.ts` registration helpers (coordination variants only for coordination endpoints). The registration contract has a negative test to catch bypasses. Keep the private CLI signing key server-side; replacing it invalidates outstanding credentials once Convex refreshes its JWKS cache. Login starts and renewals share the existing 120/minute deployment-wide budget, including unknown-key renewals; known-operation retries are not charged again. Expired device-login rows are deleted, up to four per new login start, so pending login storage stays proportional to recent logins without a scheduled job. Issued credentials and account approval-attempt rows are not deleted automatically.

Both approval pages, `/device` and the rebuilt `/-/device`, follow the same rules through one shared name component and one link-code helper (`web/src/device`). They show facts the server knows (access, lifetime, expiry) first. The device name is chosen by the terminal, so it is shown last, quoted and marked as not verified, with control and direction characters removed and a length cap; it is never a heading. A code that arrives in a link leaves the address as soon as the page loads, so it is not in the address bar, browser history or the sign-in return address; the page keeps it in that tab's session storage for at most the code's ten minutes. Such a code is never shown on the page, and Approve stays disabled until the code from the terminal is typed again, including for a remembered device; the server requires that same code and refuses request-only approval; Deny is never gated. `nforge login` links to `/device` until Clerk is removed; the removal slice points the link at `/-/device`, and a test fails if the link names a page the web app does not serve. The page tells an expired code (`AUTH_EXPIRED`) from one that already has a decision (`AUTH_CODE_USED`) by the server's error code, not by its wording; a code that was decided in another tab opens its card and says whether it was approved or denied, and a code past its expiry stops offering Approve and Deny.

## Downloads and public viewing

Cloning and downloading from Forge require sign-in, including public projects. Git ref
listings and fetches, bulk State reads and source packs refuse anonymous callers before
history, pack or object IO. Git replies with HTTP 401 and a sign-in instruction; a public
project with a GitHub mirror names that mirror as its anonymous clone route. Signed-in
public readers retain source access. Full Work archives still require owner or contributor
membership.

Public project pages, file rendering, Items and receipts remain available for viewing.
The public file viewer returns rendered file pages and derived path/map data under the
existing signed-out read budget. Raw object signing, descriptors and checkpoint plans
require sign-in, so the view response contains no storage URLs or archive plan. Viewing
necessarily delivers text to the browser; it cannot prevent saving displayed content.
Forge's archive export authenticates before any object IO, including after a cached view.
Legacy Codescape snapshot downloads also require sign-in. No raw-file or ZIP download
control is currently implemented in Code.

**Public discovery reads** (explore, profiles, a public project's front page, the sitemap; `convex/publicHttp.ts`) are one unauthenticated GET route, `/public/v1/…`, built to sit behind the site's shared cache. It takes only a handle, a slug or an explore order from a strict path parse, forwards no cookie or credential, and answers missing, private and removed projects with the same 404 body. Everything it returns passes `convex/publicVisibility.ts`: the plan follows the planning contract (an Item or Initiative marked hidden, everything under a hidden Initiative, and a members-only plan never appear, counts included; a parent that was not read fails closed), open Lanes appear as counts and stages unless the owner opted in to titles, and Lane ids and people other than the owner's handle in the address never appear. Each read is bounded (receipts of the last 7 days ≤1,000, Lane marks ≤101, open plan rows ≤3×300 plus ≤200 Initiatives, explore ≤200 rows, profile ≤100, sitemap ≤1,000). Its only write is the explore activity note, at most once per project per 10 minutes, never per visitor. Starring needs a signed-in person: agent (device) credentials are refused, one star per person per project. Only the owner person changes the Lane-title opt-in or sees who starred.

`FORGE_PUBLIC_ABUSE_BUDGETS` accepts only `{ "deviceStartsPerMinute": 120 }` (a positive
integer override). The approved default is 120 starts per minute without any setting.
There is no anonymous clone budget or counter. Device starts use one point counter
read/write; accepted retries consume no additional start. The global counter remains
shared, so one caller can still exhaust new-login availability. This is not an edge
traffic or total-spend ceiling. Signed-in Git retains the existing Worker caps. No landing
call, source byte placement or idle work changes.

GitHub Actions OIDC verification caches the fixed issuer’s keys for ten minutes,
shares in-flight refreshes, and refreshes for an unknown key at most once a minute.
Unverified token fields never choose a key endpoint. Source paths reject Windows
stream, device and filesystem alias spellings on every platform.

## Web response headers

The hosted web app is sent with `X-Frame-Options: DENY`, an enforced `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS and a restrictive `Permissions-Policy`, set in `netlify.toml`. The policy allows scripts only from the site, the inline theme script's hash, WebAssembly, Clerk and Cloudflare Turnstile (no `'unsafe-inline'` or `'unsafe-eval'` scripts), and forbids framing (`frame-ancestors 'none'`), plugins and a changed base URL. Zod runs jitless in the browser (`web/src/zod-jitless.ts`) so it never evaluates strings. `tests/web-headers.test.mjs` checks the block, that the inline theme script's hash matches `web/index.html`, and that the web entry loads the jitless setting first.

## Autonomy authority

Local CLI and MCP Channel acceptance, including the legacy Work command, is classified as an agent action. Embedded `WorkService` callers supply a trusted `AcceptanceActor` constructor context; command JSON cannot promote itself to a person. Direct native/Git acceptance uses the same policy checks. Local settings are owned by the OS user: any process with that user's filesystem authority can change them. `FORGE_ACTOR` is a self-declared label for local allowlists, not authentication or a sandbox. Use scoped device credentials for agents that require hosted policy enforcement.

Hosted policy changes require the current project owner. Forge has no general project maintainer role today; a guidance-maintainer assignment authorizes guidance only. Contributors may read policy and propose Candidates. Checked publication follows the project automatic-acceptance and exact-check rules, or explicit approval by the owner person. The owner chooses unchecked person acceptance in **Settings → Landing & checks → Who can land without a check**: **Owner only** (default), **Owner and chosen people or teams**, or **Owner and all write members**. People are picked by Forge handle and stored by account; teams are existing owner-managed teams, picked by name. A newly picked person must have current project write membership. Being listed or joining a listed team never grants write access: the person must still be a project write member when the final landing transaction runs. Removing write access, downgrading to read, leaving the selected team, or removing that team takes effect immediately, with no cleanup job. Agent credentials never receive this bypass, including the owner's and a selected person's credentials. Protected-path review and other existing acceptance rules still apply. Changes use the existing policy history, with Undo in Landing & checks. Browser account sessions count as people. Forge device credentials with `cli` scope count as agents and follow the project policy; `coordination` scope can never accept or set policy. A client actor/session label is not authority. Existing browser account JWT overrides retain browser authority, so use scoped device login for agents that need policy enforcement.

Private and public contributors follow the same check, review and protected-path rules.
Unchecked person acceptance follows the owner's selection above; agent credentials
always require an exact passing check. Explicit owner approval still reviews a
contributor's exact attempt. Receipts mark checked contributor self-acceptance as
automatic and permitted unchecked acceptance as a person's explicit action. An explicit owner-approval glob list replaces built-in
globs while retaining every defined check and setup entry file.

The server selects the landing check: the definition named `verify`, or the sole
definition when there is only one. Check-based publication with multiple definitions without `verify` requires
an explicit owner-person acceptance; unchecked person acceptance still follows
the selection above. Both solo and shared-batch publication
recheck this current selection; a submitted check id does not choose the gate.

The final hosted mutation is the unchecked-landing authority for web, CLI, MCP and agents. It rechecks current policy, caller authority and credential scope after source/evidence preparation. Checked landings, including disjoint evidence reuse, skip unchecked membership/team lookups entirely: zero additional calls, reads or writes; idle cost remains zero. Exact-Candidate passing checks, protected-path review and accepted-head preservation apply to automatic acceptance even on existing custom projects. Records include actor, policy, checked Candidate/run, action summary and undo instructions. Hosted run evidence is local-owner provenance and can be forged by that execution owner; policy does not create an independent execution attestation. Uploaded local policy never replaces hosted settings. All writers must be upgraded before a restrictive local policy is stored; format 11 prevents an older writer from ignoring it.

## Secrets for checks

Today, check definitions declare environment variable names in `env` and sensitive
names in `credentials`. Both select values already present in the runner process;
they do not fetch Secret Objects. Missing variables remain absent, rather than
failing setup by name. A CI secret must be exposed to that runner process by the
CI configuration. Forge does not perform a separate machine-key setup today.
Definition digests and receipts carry names, never values. Commands can still
print values into their CI logs; the future sealed-secret masking contract is
not implemented. See [clean check environments](#clean-check-environments).

The rebuilt **Settings → Secrets** page is value-free and currently shows that
sealed secrets are not connected. Its metadata-only interface covers names in
Development and Checks, holders, waiting computers, rotation state and recent
changes. It makes no secret reads or writes. There is no value field, reveal
control or public sample-data route. Proposed CLI commands are marked Proposed;
holder removal and sharing settings await the protocol.

The agreed replacement store is sealed Development and Checks sets, tracked by
Item `41a0df87`; it is not another Secret Object store. The design gate (Gate A)
has passed; encryption and sharing implementation remain pending. The non-encryption `nforge run` process boundary
is implemented against synthetic providers in tests; the shipped command reports
that secret delivery is not connected. Import, machine-key delivery to checks and
Secret Object retirement remain unimplemented. Gate B follows the
encryption/sharing slices and precedes delivery of the later protocol slices.
The screen and process helpers do not establish the code-review gate. Only owner devices and
machine keys are intended to hold the Checks key; other write members propose
values. The planned secret-envelope passkey uses its own ceremony and origin,
never a sign-in passkey or session material. No printable recovery key is planned.

### Run process boundary

`nforge run [--root ROOT] [--set development|checks] [--only A,B] [--show] -- COMMAND [ARGS...]`
resolves the containing clone or Lane root. The CLI reference is generated from
its help at site build time. There is no plaintext stub-input flag or alternate
secret store. Until the verified provider is connected, the command starts no
child and reports that delivery is unavailable.

The process helpers enforce these rules with synthetic values today:

- Only names in the root `.env.example` can be injected; `--only` can narrow them.
  The file must be a regular file with exactly that spelling. A symbolic link or
  directory fails with `SECRETS_ENV_EXAMPLE_NOT_FILE` before reading the provider
  or starting a child. A case-only spelling such as `.ENV.example` is reported by
  name and contributes no names. It accepts `NAME`, `NAME=value`, `export NAME=value`, blank lines and
  comments, including inline comments. Example values are ignored; duplicate
  names are used once. Refusals and missing-value/not-yet-listed notices name the
  variable and never its value. A missing file supplies no names.
- Names match `[A-Z][A-Z0-9_]{0,63}`. Release-owned deny, routing and credential
  exception lists live in `src/secret-names.ts`; they are not complete. The order
  is exact deny, exact exception, exact routing, the single Cargo token exception
  pattern, deny patterns, routing patterns, then plain names. Thus
  `CARGO_REGISTRIES_X_TOKEN` passes while its `_INDEX` and `_CREDENTIAL_PROVIDER`
  neighbours do not; `NPM_CONFIG_PROXY` is denied, and `PIP_INDEX_URL` and
  `NODE_EXTRA_CA_CERTS` are routing. Routing writes require a person in the
  shared name validator. Its value-free write boundary prints one line for each
  exempt publish-token name written to Development: it is a publish token and
  belongs in Checks. `NODE_ENV`, ordinary names and writes to Checks produce no
  such notice; using a token through `run` produces none. Live set/import/apply
  entry points remain pending.
- The inherited environment wins, including case-insensitive comparison on
  Windows. Before injection the child loses Forge credentials and session
  material: every `FORGE_*` and `NFORGE_*` name and known agent session id, except
  `FORGE_GIT_TIMEOUT_MS`, `FORGE_CHECK_FULL`, `FORGE_CHECK_SCOPED`,
  `FORGE_MAX_CONCURRENT_CHECKS`, `FORGE_CHECK_QUEUE_DIR`, `FORGE_DISK_WARN_GB` and
  `FORGE_DISK_BLOCK_GB`. These are runtime controls, not credentials.
- Checks machine delivery requires `--only` or a supervisor declaration. This
  limits what is handed over. A same-user child can still read its parent's
  startup environment; this process boundary is not OS isolation.
- Piped stdout and stderr mask injected values of at least eight characters as
  `[secret:NAME]`: raw, URL-encoded, JSON-escaped, hex, base64 and base64url at all
  three alignments. Multiline values are masked whole and line by line (lines
  shorter than eight characters pass). Each stream keeps at most the longest
  encoded form minus one byte across chunks. An agent marker, agent entry point
  or MCP keeps masking enabled even with a terminal. A person can use `--show`;
  an agent cannot. Masking stops accidents, can test a guess, and cannot prevent
  code deliberately disclosing a value.
- File values use a private folder outside the tree and declared kept-output
  paths, under `/dev/shm` on Linux or the private temporary area elsewhere.
  Folders are `0700`, files `0600`. Normal exit, startup failure and handled
  signals remove the folder; the next run also sweeps folders whose owner
  process is gone, including after SIGKILL. Live or unknown owners are retained.
  No value file is written into source, caches or archives. Buffers supplied by
  the provider are cleared after delivery.

New policy presets and projects without a stored policy protect root
`.env.example` by default, through the existing protected-path approval rules.
The match includes case variants; other protected globs retain their existing
case sensitivity. An owner's explicit `acceptance.protectedPaths` list wins and
can opt out. No existing stored policy is rewritten. Per-added-name owner alerts
are still part of the later import/landing slice, including when approval is off.

These helpers add no hosted calls, database I/O, retained records or idle work.
Masking memory scales with value encodings and one carry per stream; file bytes
are temporary only. The scriptable test backend records synthetic replies and
conditional writes. Thirty-four sealed-provider acceptance cases are explicitly
skipped until the real verifier and signed fixtures exist; they are not security
evidence. The per-added-name owner-alert acceptance case is separately deferred
to slice 3, including alerts when protected-path approval is off.

### Secrets screen trust boundaries

The route inherits the signed-in project frame. Its current provider is a local
unavailable stub, with zero Convex calls, DB I/O, storage writes or idle work.
Fixtures are confined to tests. A later server adapter must authorize current
project write access before returning names, holders or history, including on a
public project; browser state is not authorization. It must project only the
metadata contract, never values, envelopes, ciphertext or keys. Failed reads must
not render raw server errors, retain another project's data or preserve names
after access is revoked. The screen's forbidden state renders no cached metadata.

Metadata is untrusted text: React escapes displayed strings, never renders it as
HTML, and clipboard actions construct quoted name-only commands without executing
them. The clipboard is an explicit user-action boundary. No secret metadata is
written to local storage, logs, receipts or a URL. This screen is not evidence of
the future database/backup no-value guard, cryptographic revocation, hostile-server
protection, output masking or the export/retirement sequence. Those need the gated
protocol, its adversarial tests and security review before they can be claimed.

## Secret Objects

A Secret Object is an encrypted credential with versions and six independent capabilities: discover, names, use, reveal, modify and delegate.

- Versions are sealed with AES-256-GCM under the keyring in `FORGE_SECRET_KEYS`.
- The only broker operation reads one fixed GitHub repository and ref. It rejects redirects and returns only the commit SHA, version and time. Policy and version are rechecked after the provider call.
- Checks, Playbooks and repository code never receive a stored secret.
- Delegated grants depend on the current authority of every issuing delegate in their chain. Revoking a delegate also revokes their transitive grants; expiry invalidates the chain immediately, before scheduled cleanup. Re-granting access does not restore revoked descendants; restoring them requires new explicit grants. Revocation confirmation previews the affected recipients and capabilities, pinned to the policy revision; cascaded removals are audited without values.
- Successful use, reveal and configuration changes are audited without the value. Denied and failed attempts are not stored.
- Backend administrators, the keyring owner, the OS and GitHub stay trusted.
- Recovery needs the original keys. Losing an old key makes its versions unreadable.

Dotenv import creates a Secret Object and a value-free example file. It does not erase committed history or rotate the provider's credential. Rotate an exposed credential at GitHub first.

## What archives contain

Full source and Work archives hold complete retained history, run logs and selected build outputs. Listing and downloading full Work archives, checkpoints and legacy exchange parts requires current owner or contributor membership, including on public projects; reader grants and public visibility do not grant archive access. Plain accepted-source clones use State/source reads and do not need the Work checkpoint. They are not filtered by Zones and are not scanned for committed credentials (the landing scan sees only each landing's changed paths). Treat them as private. Git bundles and accepted-source clones carry full tracked history, including any committed secret.

Restoring an archive writes only named regular files into a fresh directory. It runs no hooks and does not start recorded checks. Interrupted runs stay interrupted. Ignored credential files and local configuration are not part of recovery. Hashes show the bytes are intact. They do not show who wrote them or confine execution.

Imported Git authors, timestamps and signatures are unverified claims. Comparing Candidates disables Git external diff, textconv and lazy fetch. Merging a contribution bundle copies and hash-checks it without hooks, alternates, network or credentials.

Netlify draft delivery publishes the build files you pick, using your local Netlify login. It does not run code from the target project. A successful upload says nothing about application health.

Hosted record projections and check-output reads redact local machine paths and local browser links. New owner presence and header reports redact these fields before retaining their delivery payloads. Personal cleanup lists check current GitHub and Forge access before returning repository locations, retaining cleanup identities after access loss. Actor labels require current project membership or server-retained evidence of an ended membership; cached names and imported actor declarations alone do not establish membership. Removed imports disappear from personal saved views and interests immediately. Server-retained membership provenance (not a name) survives membership removal, giving a quiet former-member label in activity, sessions and review attribution; Forge stores no provider display name, and default device, runner and machine labels never come from the hostname.

Full Work/evidence object and archive exchange still retains original bytes, which can include local paths. Generic redaction changes recorded command digests and conflicts with original local metadata during reconciliation; full transport redaction is not implemented in the current contract. Previously pinned deliveries retain their original retry bytes. Record projections do not rewrite stored rows or immutable objects. Displayed check commands can be redacted while their definition and environment digests continue to identify local originals.

Hosted Intent generation migration accepts unified Work formats 16 and 18. It
stages the replacement index before selecting it, retains the previous generation
and original backup/journal, and retries against concurrent journal or checkpoint
changes. Format 18 preserves landing entries and batches. Native and Git exchange
carry unified Intents, including those without a Lane, without down-projecting
them to legacy execution records. Deploy these hosted readers before upgrading
exchange writers or requesting hosted Intent migration.

## Passkey handles

The current Forge handle is the passkey sign-in name. The server applies the
same handle syntax and reserved destinations as account settings. A successful
registration claims its chosen handle in the same transaction, and an existing
Forge handle cannot register a second account. Existing accounts can add a
first passkey under their own handle. Changing a handle also changes its passkey
sign-in name; old URL aliases stay reserved and do not sign in. Identifier-first
sign-in retains the existing handle availability responses; it returns no
additional account profile or provider information.

## Passkey request budgets

Passkey challenge starts have a deployment-wide allowance of 120 per fixed
60-second window and 6 per exact handle. Passkey sign-up finish attempts have
an allowance of 20 per window and 3 per handle. Autofill has no handle yet and
shares the global start allowance. Convex supplies no client address, so the
global budgets are shared across visitors. These are interim defaults; the
phase 8 sign-up admission policy remains an owner decision.

The server charges in the ceremony's mutation and returns the existing
`RATE_LIMITED` error before any writes when an allowance is exhausted. Two
rows in the existing attempt-counter table reset on demand and contain at most
120 and 20 handle counters respectively. Neither rows nor per-handle entries
grow across windows; there is no polling, cleanup worker or idle work.

## Attaching account sign-in methods

An existing-provider session can enroll a passkey on that exact Forge account.
Each action verifies the session is active with its provider; each granting
mutation checks the caller's issuer, account and session proof. Existing passkeys
confirm additions. A live Convex Auth session can attach GitHub after passkey
confirmation when present and the library's completed state/PKCE round trip.
Only the provider-attested numeric id is used. App and component identity
ownership are checked transactionally; conflicting accounts are never merged.
Successful grants and their secret-free audit receipts commit together. Retry
receipts prevent duplicate grants; GitHub tickets remain single-use.

These browser flows do not establish ownership of non-provider agent/bot keys.
Existing CLI access remains; long-term renewal and the deliberately unmatched
accounts need owner review before removal. Clerk remains configured. See
[the linking runbook](development.md#attach-sign-in-methods-to-an-existing-account)
for proof boundaries, retries, scale and the migration exclusion.

### Current verified addresses in the rebuilt sign-in

Each GitHub sign-in replaces both the address and verified flag from its current
profile. If GitHub reports no verified address, Forge clears the old address and
flag, including on the linking path. A passkey-only account has no email-based
invitation authority. The browser identity resolver supplies these fields from
the already-read account row, never from a stale token claim.

New-account recipient lookup uses an exact normalized verified address and refuses
ambiguous matches. Explicit invitation acceptance rechecks that unique current binding;
no unverified address accepts an email invitation. The retained provider path remains
until its separate removal checklist is complete. Browser-session management
checks the live session and a fresh account-bound passkey or GitHub proof before
revoking other sessions; no session id supplied by a client selects another
account's sessions.


Team email additions retain the exact current verified native binding and the
configured legacy provider comparison. Different account matches grant nothing;
same-account matches proceed and the grant transaction rechecks the native
binding. Project membership uses the pending invitation path instead: retained
agent approvals and older project add APIs create invitations and the recipient
accepts. A completed invitation retry performs no directory lookup, grants no
membership and sends no second email. Legacy add APIs explain an ended invitation
instead of silently succeeding. Pre-change invitation rows require the original
operation's inviter to remain the project owner. Removing membership invalidates
that account's earlier open invitations atomically, without resolving pending
addresses in owner reads.
