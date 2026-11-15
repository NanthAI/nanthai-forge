# Journey 28: protected paths

Marking parts of a project that an agent may not change alone, and what happens when one does. Issue a0cf8c22 lists it under team and trust. [Journey 7](07-people-access.md) maps the approval page a held landing leads to; this file maps choosing the paths, the agent's experience before and during the hold, and the neighbouring mechanisms.

Walked: `policy`, the Autonomy settings source, the governance doc, the workflows doc (trust per path per actor), `help queue` and `help wait` as read in part 1, and the open Issues 7f085ec9, 517523cf, 6bd7ddb1 and 16f6fdd7. **Not walked:** changing the list, and a held landing.

## Steps today

| # | Step | What happens | Evidence |
| --- | --- | --- | --- |
| 1 | The default list | Every project starts with owner-approval paths: `.github/**`, `scripts/forge-check.mjs`, `.forge/**`, `forge.config.*`, `netlify.toml` and `netlify/**`, `scripts/deploy*` and `scripts/deploy/**`. "The defaults also cover the files that every check definition of the project and its setup action runs". | docs |
| 2 | Read the list | Web → Settings → Autonomy: a row "Protected paths" with the paths or "None", and an editor headed "Protected paths — always a person" with paths as chips. CLI: `policy '{}'` → `acceptance.protectedPaths`. On the Forge project: the defaults plus `.forge-secret-allow.json`. | source, ran |
| 3 | Change the list | Owner on the web: edit the chips and save. From any terminal sign-in: `x set-policy '{"acceptance":{"protectedPaths":[…]}}'` is held as an approval request for the owner on the web ([journey 6](06-settings.md)). | source, docs |
| 4 | Two lists | `acceptance.protectedPaths` is "the separate all-agent review list". `acceptance.ownerApprovalPaths` "replaces the public default list; omit it to retain the defaults, or explicitly set `[]` to disable this public path gate". | docs |
| 5 | Whom it holds | "Every agent, the owner's own agents included (any device sign-in, such as nforge login, is an agent); on a public project it also applies to contributor persons. Only the owner person skips it." | docs |
| 6 | An agent edits a protected path | The copied briefing carries one line, "Acceptance: MODE. Protected paths: …" (the list cut at 140 characters). An agent that starts from the CLI gets the list only if it reads `policy`. No warning was found on the file write or the save. The landing runs its check, then stays pending: "needs owner approval: protected paths X, Y", "even after checks pass". It "stays listed in queue without a position". | source, docs |
| 7 | The agent asks | `approve-link '{"operationId":"…"}'` returns the approval link; the agent passes it to its person. | docs |
| 8 | The person decides | The approval page: **Accept into main** or **Decline** ([journey 7](07-people-access.md)). If main moved: "this exact source is checked again on current main and lands with your approval." | source |
| 9 | The list changes while a landing is held | "A held landing can land without review after a policy change" (journey 7, J7-8). A policy change also invalidated unrelated queued landings (open Issue 16f6fdd7: "POLICY_CHANGED wasted a full check for an unrelated protectedPaths edit"). | docs |
| 10 | Neighbouring mechanisms | Trust per path per actor: earned, `trust:{"enabled":false}` on the Forge project (open Issue 7f085ec9). Path owners and approvals bound to what lands: open Issue 517523cf. Private files and per-path visibility: open Issue 6bd7ddb1 ([journey 29](29-secrets-private-files.md)). Zones: readers of part of the source ([journey 14](14-setting-up-agents.md)). | ran, docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J28-1 | S1 | **An agent learns that its change is held after its check has run.** The list is one line in the copied briefing and a field in `policy`. No reply at `start`, at the first write or at `save` says "this file needs your owner's approval to land". The agent finishes the work, spends the CI minutes and then waits for a person who may be away. The paths are known to Forge from the first save. | docs |
| J28-2 | S2 | **Two lists with similar names decide the same thing.** `protectedPaths` (all agents, every project) and `ownerApprovalPaths` (the public-project default list, also applied to contributor persons). The web shows one editor. An owner who empties the visible list still has the other. | docs, source |
| J28-3 | S2 | **The default list is invisible until it bites.** A new project's owner never chose `.github/**` or `scripts/deploy*`. The first time an agent edits a workflow file the landing is held, and the reply names paths, not the reason they are on the list (they change what checks run or what deploys). | docs |
| J28-4 | S2 | **The owner's own terminal is "an agent".** This is deliberate and well reasoned in the governance doc. To the owner it reads as Forge refusing them: they change a workflow file themselves, land it from their terminal, and are told to approve their own change in a browser (journey 7, J7-7). | docs |
| J28-5 | S2 | **Paths are globs typed by hand, with no preview.** The editor takes chips. Nothing shows which files a pattern matches, how many recent landings it would have held, or that a pattern matches nothing. | source |
| J28-6 | S2 | **Editing the list has side effects on work in flight** (step 9): a held landing may land unreviewed, and unrelated queued landings were checked again. The settings page says neither. | docs |
| J28-7 | S2 | **Four mechanisms answer "who may change this file"** (journey 14, J14-7): protected paths, trust per path, Zones and, when built, path owners and private files. Each has its own vocabulary: protected, owner-approval, trusted, autonomous, Zone reader, audience. | docs |
| J28-8 | S3 | **"Protected paths — always a person" is the clearest label in the settings** and says what the list does. The CLI field name and the refusal ("needs owner approval") use different words for it. | source, docs |
| J28-9 | S3 | **A person with the write role is held on a public project and not on a private one.** The rule is in the governance doc; the settings page does not show who a path holds. | docs |

## Dead ends

- An agent finding out before it works whether its landing will be held (the agent-side need named in journey 7).
- Seeing which files a pattern covers.

## Naming and tone

- Protected (web, policy), owner-approval (governance, refusal), held (queue), review (codes). The owner's vocabulary decision gives **approve** for the person's yes; the list needs one name.
- "Always a person" is plain and true. Keep it.

## What each persona needs

- **Agent, not person:** a warning at the first write to a protected file, and again at save, with the link request ready; the choice to split the protected part into its own Lane so the rest can land.
- **Person, not agent:** to see the default list when the project is created, with the reason for each entry; a preview of what a pattern matches; one place that shows, for a file, who can change it alone.

## Questions for the owner

1. Should an agent be told at the first write that a file is protected, and offered to split that part into its own Lane?
2. One list or two? Can `protectedPaths` and `ownerApprovalPaths` become one list with a "who is held" setting?
3. May the owner approve from the terminal that made the change, with a second factor (journey 7, question 5)?
4. Does changing the list ever release a held landing without a decision, or should a held landing always need its decision?
5. Is "protected paths" the base for path owners (517523cf) and private files (6bd7ddb1), so people learn one concept, a Zone with rules?
