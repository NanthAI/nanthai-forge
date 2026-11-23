# Journey 37: running Forge yourself

A third persona, the **operator**: a person who hosts Forge for themselves or a company instead of using a hosted service. This journey is not on the list of Issue a0cf8c22. It comes from the product direction ("an open source replacement for the GitHub workflow … with a free core") and open Issue aed285f0 ("Free self-host: the whole product stays open source with no paywalled core").

Walked: the operations doc (self-host, backup and recovery headings, R2 storage), the development doc (environment names), the quickstart, the browser environment example file, LICENSE references and `nforge --help`. **Not walked:** a self-hosted instance. Nothing here was run.

## Steps today

| # | Step | What the docs give | Evidence |
| --- | --- | --- | --- |
| 1 | Decide whether it is supported | "A loopback development setup with no TLS, public ingress or production guarantee." "The launcher supports macOS arm64 and Linux x64." | docs |
| 2 | Start a backend | `npm ci --ignore-scripts`; `node scripts/selfhost.mjs init DIR BACKEND.zip PORT` ("verifies the pinned SHA-256 first"); `node scripts/selfhost.mjs start DIR` ("foreground; Ctrl-C stops it"). The backend zip is downloaded by hand from a pinned release. | docs |
| 3 | Deploy Forge's server code to it | Three `npx convex` commands with `--env-file DIR/deployment.env`. "Convex rejects reads of unset auth-config variables … Set both issuer variables explicitly; an empty string keeps that provider disabled." | docs |
| 4 | Storage | "A self-hosted instance stores bytes in R2 like every deployment … Set the `R2_*` settings, or `R2_ENDPOINT` for another S3-compatible bucket. Without them, every byte write fails with `R2_NOT_CONFIGURED`." | docs |
| 5 | Sign-in | "For a new anonymous instance" the CLI issuer is disabled. "For private access, set the Convex Auth and GitHub App variables." Since de67c77d, self-hosters need no third-party auth account. | docs |
| 6 | The web app | Build with two environment values and "vite build web --mode hosted". Where to serve it is not described. | docs |
| 7 | GitHub App | Needed for private imports, the mirror and checks on GitHub Actions. An operator registers their own App. | docs |
| 8 | Point the CLI at it | `nforge login DEPLOYMENT_URL`. "Use the development app and deployment URL supplied by its operator." | docs |
| 9 | Back up and restore | `npx convex export --include-file-storage …`. "A snapshot holds documents and files. It does not hold deployed code, backend environment, instance config or local Work stores." "File-inclusive snapshots hold only legacy copies, not the bucket." Restore: "start a fresh instance, import first, then deploy". | docs |
| 10 | Upgrade | "Create a fresh instance with the new pin and restore a snapshot into it." | docs |
| 11 | Check it works | `node scripts/selfhost-smoke.mjs` imports one small public repository; "it needs a read-only GITHUB_TOKEN". | docs |
| 12 | Licences | All original Forge code AGPL-3.0-only; the downloaded backend has its own terms. | docs |
| 13 | Operate it | `nforge maintenance …`, `nforge worker …`, `nforge metrics record-bill …`, `nforge cli release-sign` are in the same top-level help as everyday commands (journey 1, J1-5). | ran |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J37-1 | S1 | **Self-hosting is described as a development loop, not as a way to run Forge.** No TLS, no public address, a foreground process, a hand-downloaded backend and a storage bucket to supply. The business model under discussion makes self-hosting the free plan. A person who reads "free self-host" and then this section will conclude it is not really offered. | docs |
| J37-2 | S2 | **There is no single page for an operator.** The steps are a section in an operations document of more than 1,400 lines, with environment names in the development doc, the GitHub App in a third and storage in a fourth. | docs |
| J37-3 | S2 | **Three outside services are needed and none is optional in practice.** Object storage (required), a sign-in provider (until de67c77d), and a GitHub App (for imports, the mirror and the common check route). The "no dependency on another private product" rule holds; the list of public ones is not stated up front. | docs |
| J37-4 | S2 | **Backup does not cover the bytes.** The documented snapshot holds records; source bytes live in the bucket and are "not" in it. An operator who follows the backup section alone cannot restore a project. | docs |
| J37-5 | S2 | **Upgrading means a new instance and a restore.** There is no in-place upgrade. With the CLI updating itself to main and a server that must match it ("mixed installs" are a known hazard in the roadmap), an operator has no stated way to stay in step. Release channels (29fbe61c) cover the CLI side only. | docs |
| J37-6 | S2 | **Operator and user commands share one help screen.** A user sees `maintenance`, `worker`, `recover`; an operator has no operator section. | ran |
| J37-7 | S3 | **Cost guidance exists for the hosted service, not for an operator.** The cost documents state dollars per 1,000 landings for the team's deployment. An operator sizing their own has no "a team of N agents needs about this". | docs |
| J37-8 | S3 | **Licence terms are stated in the right place and are three licences.** Server, client and backend differ. A company evaluating self-hosting needs that in the first paragraph. | docs |

## Dead ends

- A production self-host: stated as unsupported.
- Restoring a project from the documented backup alone.

## Naming and tone

- Deployment, instance, backend, development app, hosted, self-host, operator, owner. "Owner" means the project's owner elsewhere and sometimes the service's owner here.
- The section is honest about its limits in its first line. That honesty belongs on whatever page offers self-hosting.

## What each persona needs

- **Agent, not person:** nothing different, except a reply that names the service it is talking to ([journey 22](22-many-projects.md), J22-6).
- **Person, not agent (operator):** one guide from nothing to a working, backed-up instance with a real address; a list of what must be supplied; an upgrade path; a statement of what is supported.

## Questions for the owner

1. Is production self-hosting a supported offer at the beta, or "possible, unsupported" until later? The public pages need one of the two sentences.
2. If supported: what is the packaged form (a container image, a compose file) and who maintains it?
3. Does the self-host guide become one page for operators, separate from Forge's own operations notes?
4. What is the upgrade promise for self-hosters: which CLI versions work with which server versions?
5. Does the backup guide cover the storage bucket, so one procedure restores a project?
