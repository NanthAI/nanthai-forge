# Journey 13: connecting CI

Giving a project the check that decides its landings: Forge's runner on GitHub Actions, the project's own CI file, a machine the owner runs, the secrets a check needs, and a check that never reports. [Journey 6](06-settings.md) covers how a landing uses the check (modes, admission, Automatic and Manual); [journey 4](04-failed-check.md) covers a check that fails.

Walked: `check-settings`, `help check`, `help wait`, `help limits`, the checks settings sources, the quickstart, the GitHub Actions, CI status, self-hosted runner, runner fallback and pre-queue check docs. **Not walked:** `configure-check`, `configure-runner`, a first landing on a new project and any run on a second CI provider (each changes a project).

## Steps today

### Three ways to run the check

| Route | Setup | Who pays for minutes | Limits |
| --- | --- | --- | --- |
| **Forge's runner on GitHub Actions** (`provider:"github-actions"`) | 1. Put Forge's check workflow (`forge-check.yml`) in a runner repository. 2. Install the Forge GitHub App there. 3. `configure-check '{"command":{"name":"verify","executable":"bash","args":[…]}}'`. 4. `configure-runner '{"provider":"github-actions","repository":"OWNER/RUNNER_REPOSITORY","runsOn":"ubuntu-latest"}'`. "configure-runner proves that your linked GitHub account administers or maintains it and records a runner grant that also covers your later projects." | The runner repository's GitHub account. Free on public repositories. | Forge's test selection and shards apply to Forge's standard check script. "Other configured commands run once in the static job." |
| **Your own CI file** (`provider:"ci-status"`) | 1. Turn on the mirror. 2. Add `'forge/candidates/**'` to the workflow's `push` branches. 3. `configure-runner '{"configuration":{"provider":"ci-status","ci":{"adapter":"github-actions","repository":"OWNER/NAME","workflow":".github/workflows/test.yml"},"runtime":"000…0","environmentFingerprint":"000…0"}}'` (two 64-character placeholders). | The mirror repository's account. | "GitHub Actions publishes. GitLab CI is verified by the contract test … but cannot publish yet, so the setting refuses it." An outside contributor's Candidate "settles `runner-unavailable` … and needs a check on Forge's own runner." |
| **A machine you run** (self-hosted runner; "connected computer") | `nforge worker DEPLOYMENT_URL PROJECT_ID MACHINE_UUID` as a service, with `FORGE_AUTH_TOKEN` from "your service's secret facility". | You. | Runs with the user's OS rights: "A clean environment is not an OS sandbox." |

### Reading the setup

| Where | What it shows |
| --- | --- |
| `check-settings '{}'` (ran) | `definitions` (three checks: `verify`, `measure-single-job-E`, `measure-web-typecheck`), `finishCheck` (an id), `runner.configuration` (`provider`, `repository`, `runsOn`, `publicLogs`, two fingerprints), `actions` (`mode:"app-direct"`, `workflow`, `concurrencyBudget:12`, `isolation:"user"`, `results:"OIDC session plus workflow_run webhook"`), `runnerGrant`, `mainAudit`. One plain sentence: "Check logs are public: this runner runs in OWNER/NAME, whose GitHub Actions logs, test names, paths and printed output anyone who can see that repository can read (the project owner set publicLogs:true)." |
| Web → Settings → Checks (source) | A list of checks with runs and "Last run"; "No checks defined."; "Only owners can change this"; a disclosure "Define a check locally" that prints a `define-check` command (refused on hosted projects; journey 6, J6-12). No runner, provider or secret is shown. |

### Secrets for a check

| Need | Route |
| --- | --- |
| An environment variable or a credential in the check | Declare names, never values: `"env":["SERVICE_URL"],"credentials":["SERVICE_TOKEN"]`. "Omitted variables are absent; failed runs suggest omitted names that may need passthrough." The values must already exist on the runner (a GitHub Actions secret, or the machine's service environment). (docs) |
| Toolchain locations on Actions | A fixed allowlist (`JAVA_HOME`, `GOROOT`, `CARGO_HOME` …). "No name containing TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH or KEY passes, whatever pattern it matches." (docs) |
| Secrets held by Forge | Settings → **Secret Objects** exists ("Create Secret Object", "Import a GitHub credential from .env", "Rotate credential", "Capabilities", "Audit events"), but check declarations "do not inject Secret Objects". (source, docs) |

### A check that never reports

| Situation | What Forge does | What the agent and person see |
| --- | --- | --- |
| The dispatch was accepted but no run started | One provider lookup at +5 minutes. A missing run settles as `runner-unavailable` "with a provider-outage reason" and is retried (three checks in total). | `CHECK_NOT_PASSED` after the retries. (docs) |
| Shards passed but the provider's status lags | Fixed reads at +10 s, +30 s, +5 min, +30 min, +1 h, +2 h, +4 h. A complete job list with every step done passes at +30 minutes, recorded as `provider-delayed`. | `provider-delayed` "with the time since the last shard and next fixed read". (docs) |
| Nothing at all | "One 12-hour watchdog bounds a missing completion event." The landing reports `LANDING_STALLED` after 15 minutes without progress. | `help wait`: "Read queue '{}', then land --save again from the same Lane." (ran) |
| No check is defined | A fresh import cannot land: `land --save` has nothing to run. | Not walked. |
| No test covers a code change | `ZERO_SELECTION`. A docs-only change records `check.skipped` with `status:"not-affected"`. (docs) |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J13-1 | S1 | **The first check takes a repository, a workflow file, a GitHub App and two JSON commands, with no screen.** The web shows a list of checks and nothing about the runner. A person who imported a repository on the web has to leave for the terminal and the docs before anything can land. Onboarding pattern: the first value is behind the longest step. | source, docs |
| J13-2 | S1 | **The simplest route is the hardest to find.** "Use the CI file you already have" is one trigger line. It lives in an operations doc, needs the mirror first, and its command asks for two 64-character placeholder values ("pass any 64-character hex value"). The quickstart teaches the other route. | docs |
| J13-3 | S2 | **Three routes, and nothing helps choose.** Forge's runner gives selection and shards; your own CI file gives no setup; a machine gives control. Who pays, what a pass proves and what outside contributors get differ for each. No table compares them (the one above was assembled from four docs). | docs |
| J13-4 | S2 | **Names for the runner differ by surface.** Runner, runner repository, provider, adapter, worker, "connected computer", machine, `runsOn`, `mode:"app-direct"`. The owner's phrase is "your own CI". | ran, docs, source |
| J13-5 | S2 | **`check-settings` is a configuration dump.** Digests, fingerprints, cursors and an installation id surround the three facts an owner wants: which check decides a landing, where it runs, and whether its logs are public. `finishCheck` is an id, not a name. | ran |
| J13-6 | S2 | **Secrets for checks have two unconnected systems.** Check declarations pass names through from the runner's own secret store. Forge's Secret Objects page looks like the place to put a CI secret and is not used by checks. Nothing on either says so. | source, docs |
| J13-7 | S2 | **A missing secret is discovered by failing.** "Failed runs suggest omitted names that may need passthrough" is helpful after the fact. Nothing checks, when a check is defined, that the runner has the named secrets. | docs |
| J13-8 | S2 | **Public logs are easy to switch on without seeing the consequence.** The sentence in `check-settings` is exactly right. It appears after the setting is made, in a read; the web has no such line. A secret printed by a test becomes public. | ran, source |
| J13-9 | S2 | **A stalled check has three clocks and one unclear instruction.** 5 minutes (startup lookup), 15 minutes (`LANDING_STALLED`), 12 hours (watchdog). The stalled instruction is disputed between the help and the rule (journey 4, J4-1; open Issue c24edcb2). An open incident (a7de3a93) records a queue head "checking for 12 h" after a lost dispatch. | ran, docs |
| J13-10 | S2 | **`runner-unavailable` covers five different causes.** No run started, a provider outage, an outside contributor on a `ci-status` project, a retired provider, incomplete job evidence. The reason is a second field. | docs |
| J13-11 | S2 | **A second CI provider is promised and not usable.** The contract test covers GitLab; "the setting refuses it". Bring-your-own CI is an owner rule (it must work with any CI). Today the usable set is GitHub Actions and your own machine. | docs |
| J13-12 | S3 | **The web's "Define a check locally" prints a refused command** (journey 6, J6-12; open Issue e41b074c). | source |
| J13-13 | S3 | **Check live output is not visible while it runs** (open Issue 42b8bf0e). The full log "stays with the provider"; Forge keeps a 64 KiB tail per job. | docs |

## Dead ends

- A person on the web after an import: no control leads to a first check (J13-1).
- GitLab or any CI other than GitHub Actions.
- An outside contributor's change on a project that uses its own CI file.
- A Secret Object as a check secret (J13-6).

## Naming and tone

- "Check" is the word people see; "gate", "verify", "audit", "run", "execution", "shard" and "job" all appear in replies. PRODUCT.md bans "job" and "pipeline" in product UI.
- The docs are exact about what a pass proves ("A job that reports its own status never passes a check"). That sentence is a selling point and sits in an operations page.

## What each persona needs

- **Agent, not person:** to know before it starts whether a check exists and which command it runs; the changed-paths file (present); a single terminal word for "the infrastructure failed, not your change".
- **Person, not agent:** a setup that starts from "which CI do you already have?"; who pays for the minutes; whether logs are public; where a secret goes; a test run of the check before the first landing depends on it.

## Questions for the owner

1. Which route is the default for a new project: your own CI file (least setup) or Forge's runner (selection and shards)?
2. Should connecting CI be a web flow under Landing & checks, with the CLI as the agent's route?
3. Are Secret Objects meant to feed checks? If not, where does the product tell people to put CI secrets?
4. Is there a "try the check now" step before the first landing?
5. When does a second CI provider have to be usable for real: at the public beta, or later (open Issue a697aba8 is in Phase 8)?
6. What does a person see when checks have no runner at all: a blocked landing with a setup link, or a project that cannot be created without one?
