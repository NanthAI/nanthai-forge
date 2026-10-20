# Security

Forge is development software. It has no security certification and no production release. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Source is data, execution is not

Capture and analysis read untrusted repository bytes. They never run imports, hooks, manifests or package scripts. Source text, comments, Markdown and provider metadata stay data, including text written to address an agent. Rendered Markdown omits raw HTML and runs no JavaScript.

A check or Playbook runs repository code under your OS account. Lanes, Git worktrees, the local server token and MCP credentials do not confine the file system, processes, network or other agent tools. There is no sandbox. Checks use the clean environment described below, and logs can contain anything the command prints. Local run records and exit codes are observations. Code with your OS authority can forge them.

### Hosted check authorization

Queueing a hosted check requires current project owner or contributor access and ownership of the selected runner (`runner.actor` must match the caller). Project ownership alone does not authorize queueing on another person's runner. Contributor proposals run on the owner's computer only when that runner's owner queues them. Runner polling and claiming enforce the same ownership rule, including for retained requests created before it was enforced; those requests are not rewritten.

Only the request's creator, the runner's current owner or the project owner may cancel or update a request, and each must still have current project write access. Revoked contributors and read-only viewers cannot queue, cancel or update checks, including retries. Result updates retain the original request, runner and run pins and terminal-result reconciliation. Reports remain observations rather than execution attestations. The canonical owner listener accepts recheck requests only from the current project owner.

### Clean check environments

Every check, including Playbook steps and event automations, starts with private empty `HOME`/`USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and temporary directories under its private run directory. `TMPDIR`, `TEMP` and `TMP` point there. These directories are removed with the disposable workspace; interrupted or changed workspaces retain them until ordinary check-workspace cleanup. Saved `nforge login`, npmrc and cloud/CLI configuration are not discovered through the user's HOME or XDG paths.

The environment allowlist is `PATH`, `LANG`, locale names matching `^LC_[A-Z_]+$`, `TZ`, `TERM`, and Windows tool lookup settings `SystemRoot`, `WINDIR`, `PATHEXT`. Forge's runtime controls `FORGE_GIT_TIMEOUT_MS`, `FORGE_CHECK_FULL`, `FORGE_CHECK_SCOPED`, `FORGE_MAX_CONCURRENT_CHECKS`, `FORGE_CHECK_QUEUE_DIR`, `FORGE_DISK_WARN_GB` and `FORGE_DISK_BLOCK_GB` are also forwarded. Forge sets `CI=true`, the private directory paths, `npm_config_userconfig` and `npm_config_globalconfig` to private empty configuration locations, and `npm_config_cache` to a dedicated shared content cache at `~/.cache/nanthai-forge/check-npm-cache`. That cache is separate from the user's npm cache and configuration and receives no npmrc auth. Its absolute path still identifies the runner's home location. Node/npm create their own runtime variables when invoked; ambient `NODE_OPTIONS` and npm configuration are not inherited.

Everything else is absent by default, including `FORGE_AUTH_TOKEN`, `FORGE_AGENT_TOKEN`, other `FORGE_*` credentials, `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*` and `CONVEX_DEPLOY_KEY`. This is an allowlist, so new credential variable names are absent too.

The runner supplies its own `FORGE_CHECK_CHANGES`, `FORGE_CHECK_BASE`, `FORGE_CHECK_HEAD`, `FORGE_CHECK_SELECTION` and, for interaction runs, `FORGE_CHECK_INTERACTION`. These describe the pinned check input and output paths; they do not inherit ambient values, even when declared for passthrough. Unavailable comparison input leaves the corresponding comparison variables absent. The allowlisted controls above remain ordinary runtime settings, so a clean check is not expected to have zero `FORGE_*` variables.

A check definition may explicitly declare `env: ["NAME"]` and/or `credentials: ["TOKEN_NAME"]`. Both pass exactly those variables from the runner process, including credential variables if explicitly selected; `credentials` labels sensitive passthrough separately. Missing variables stay absent. Explicit selections can override generated defaults, including HOME or npm configuration. Declarations are canonicalized and included in the definition digest. Values are used transiently and are not copied into Work metadata, environment fingerprints or receipts. Definitions and receipts show the names; arbitrary command output may still disclose values. These declarations do not resolve or reveal Secret Objects: those remain available only through their existing controlled broker operations.

Declaring `env: ["HOME"]` restores home-relative access to all files under that HOME; it does not also restore `USERPROFILE`, XDG settings or cloud credential variables. Declaring `credentials: ["AWS_SHARED_CREDENTIALS_FILE"]` instead exposes that configured file path while leaving HOME private and other `AWS_*` variables absent. Neither declaration grants filesystem authority: the process already runs with the user's OS rights.

Definitions without declarations continue to execute in the clean environment. Failed runs record a value-free “may need env passthrough: X” suggestion listing omitted parent environment names; it is diagnostic, not proof of the failure's cause. Environment fingerprints cover the clean runtime policy and allowlisted settings, not undeclared external inputs or passthrough values.

Clean environment isolation prevents ambient discovery through inherited settings. Repository code still has the user's OS authority: it can read known absolute paths, discover the account home through OS APIs, access other processes or the network, and alter shared cache contents. It cannot be claimed unable to read a credential file by every route. Strong protection from hostile code requires separate OS isolation. Upgrade the local runner to obtain this behavior; older binaries retain their previous execution behavior.

`tests/check-environment.test.mjs` exercises real local checks against synthetic HOME files: SSH keys, AWS configuration, saved Forge/GCloud configuration, npmrc and dotenv files. It verifies default read failures, omitted credential variables, exact-name and HOME/file-path opt-ins, and the known-absolute-path boundary without reading real credentials. Source capture excludes newly encountered `.env.local` files; clean environments do not scrub secrets already retained in source or printed by a command.

Handing a secret to arbitrary code lets that code leak it.

## Access is checked before retrieval

Forge sign-in, GitHub App installation and a person's repository entitlement are separate. Every read of private imported source, graph or export checks current policy and current provider entitlement. Policy is rechecked after provider calls. A saved snapshot, an old grant or a download never creates new access.

Paths, counts, search results and relationships derived from source are part of the visibility boundary.

- **Named readers and reader teams** share a whole private import. Both the importer and the reader need current GitHub entitlement.
- **Source Zones and scoped agent grants** expose selected pinned files and a graph built from only those files. The source text can still mention hidden files, so filtering cannot promise that visible code reveals nothing about hidden code.
- **Scoped agent grants** are time-limited bearer tokens. They allow source reads only: no Work writes, execution, documents or secrets. Expiry, revocation and the creator's entitlement are checked on every read. Refreshing never widens scope. A token represents the owner, not a verified process. Grants cannot limit other tools, files, network or spend.
- **Hosted contributors** get whole-project access through their own flow. A contributor can download the full source archive and return a proposal. Contributors may create Intents, and add notes or change status on Intents they created or are assigned. Creator and assignment lookups use authenticated account IDs in the selected Work generation, with original hosted creation events retained as creator evidence; Lane session labels grant no authority. Revoking contributor access or removing an assignment takes effect on the next write, including retries. Proposal list, detail and download reads follow project visibility. They cannot change project policy or accept Channels.

Downloaded data cannot be recalled. GitHub readers of a full repository already have that access independently of Forge.

After GitHub access is lost, an importer can still list and delete their own imports. That cleanup metadata does not allow reading source, graphs, exports or Restore. Permanent deletion removes objects that only that project owned, and keeps shared objects and minimal receipts. It does not purge provider backups or downloaded copies.

## CLI device credentials

Device approval issues a Forge-signed JWT with audience `forge-cli`, not the approving browser's Clerk session JWT. The server stores only code/token hashes plus device metadata, approving subject, scope, expiry and revocation state. The server derives unpredictable device secrets and short user codes from a login nonce under its private key; start retries reconcile without storing plaintext codes. Codes expire after ten minutes. A decision is single-use and bound to its approving account. Redemption is single-use; retries with the same operation ID reconcile the original credential. Polls are spaced five seconds apart; approval lookups/decisions allow ten attempts per account per minute. Code hash comparisons use constant-time crypto verification.

CLI credentials expire after 30 days and are revocable from account settings or logout. Re-login is the renewal path. The CLI stores credentials in a user-owned `0600` file; it never prints the token. Environment overrides remain available. Every public backend function checks Forge credential revocation, expiry, approving subject and scope; actions recheck before returning. Signed credential markers retain these checks while issuer configuration changes. Existing current project, contributor, GitHub and source policies still apply. Coordination-only credentials cannot read source, exchange checkpoints or change hosted Work. A CLI credential is bearer authority for the selected scope, not a process identity or sandbox. Self-revocation can be retried after revocation and cannot grant access.

New public Convex functions must use `convex/cliServer.ts` registration helpers (coordination variants only for coordination endpoints). The registration contract has a negative test to catch bypasses. Keep the private CLI signing key server-side; replacing it invalidates outstanding credentials once Convex refreshes its JWKS cache. No automatic deletion of device records is introduced.

## Autonomy authority

Local CLI and MCP Channel acceptance, including the legacy Work command, is classified as an agent action. The local `nforge serve` Work API (`/api/work`) with its server token is classified as a person action. Embedded `WorkService` callers supply a trusted `AcceptanceActor` constructor context; command JSON cannot promote itself to a person. Direct native/Git acceptance uses the same policy checks. Local settings are owned by the OS user: any process with that user's filesystem authority can change them. `FORGE_ACTOR` is a self-declared label for local allowlists, not authentication or a sandbox. Protect the server token and do not give it to an agent that should need review.

Hosted policy changes and Channel acceptance require the current project owner. Forge has no general project maintainer role today; a guidance-maintainer assignment authorizes guidance only, never autonomy settings or acceptance. Contributors may read policy and propose Candidates but cannot change policy or accept. Browser account sessions count as people. Forge device credentials with `cli` scope count as agents and follow the project policy; `coordination` scope can never accept or set policy. A client actor/session label is not authority. Existing browser account JWT overrides retain browser authority, so use scoped device login for agents that need policy enforcement.

The final hosted mutation rechecks current policy, caller authority and credential scope after source/evidence preparation. Exact-Candidate passing checks, protected-path review and accepted-head preservation apply to automatic acceptance even on existing custom projects. Records include actor, policy, checked Candidate/run, action summary and undo instructions. Hosted run evidence is local-owner provenance and can be forged by that execution owner; policy does not create an independent execution attestation. Uploaded local policy never replaces hosted settings. All writers must be upgraded before a restrictive local policy is stored; format 11 prevents an older writer from ignoring it.

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

Full source and Work archives hold complete retained history, run logs and selected build outputs. They are not filtered by Zones and are not scanned for committed credentials. Treat them as private. Git bundles and accepted-source clones carry full tracked history, including any committed secret.

Restoring an archive writes only named regular files into a fresh directory. It runs no hooks and does not start recorded checks. Interrupted runs stay interrupted. Ignored credential files and local configuration are not part of recovery. Hashes show the bytes are intact. They do not show who wrote them or confine execution.

Imported Git authors, timestamps and signatures are unverified claims. Comparing Candidates disables Git external diff, textconv and lazy fetch. Merging a contribution bundle copies and hash-checks it without hooks, alternates, network or credentials.

Netlify draft delivery publishes the build files you pick, using your local Netlify login. It does not run code from the target project. A successful upload says nothing about application health.

Hosted record projections and check-output reads redact local machine paths and local browser links. New owner presence and header reports redact these fields before retaining their delivery payloads. Personal cleanup lists check current GitHub and Forge access before returning repository locations, retaining cleanup identities after access loss. Actor labels require current project membership or server-retained evidence of an ended membership; cached names and imported actor declarations alone do not establish membership. Removed imports disappear from personal saved views and interests immediately. Recorded actor names survive membership removal, with a quiet former-member label in activity, sessions and review attribution.

Full Work/evidence object and archive exchange still retains original bytes, which can include local paths. Generic redaction changes recorded command digests and conflicts with original local metadata during reconciliation; full transport redaction is not implemented in the current contract. Previously pinned deliveries retain their original retry bytes. Record projections do not rewrite stored rows or immutable objects. Displayed check commands can be redacted while their definition and environment digests continue to identify local originals.

Hosted Intent generation migration accepts unified Work formats 16 and 18. It
stages the replacement index before selecting it, retains the previous generation
and original backup/journal, and retries against concurrent journal or checkpoint
changes. Format 18 preserves landing entries and batches. Native and Git exchange
carry unified Intents, including those without a Lane, without down-projecting
them to legacy execution records. Deploy these hosted readers before upgrading
exchange writers or requesting hosted Intent migration.
