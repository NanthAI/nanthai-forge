# Journey 21: plans, billing and limits

What Forge costs, what is free, where the limits are and what happens at one. Pricing is not decided (the owner decides after the benchmark and real beta usage), so this file maps what exists today and what a person or agent will ask. [Journey 9](09-cost-usage.md) covers what a project's own work cost; this file covers what Forge charges and allows.

Walked: `help limits`, the limit and quota source (`convex/abuseLimits.ts`), the status, roadmap, security, Git serving and import docs, and the open Issues 7a2e4011, aed285f0, 679171e6, 93907d28, 13bccc12, 30ce7f72 and a91b9b69. **Not walked:** hitting a limit.

## Steps today

| # | Question | Answer today | Evidence |
| --- | --- | --- | --- |
| 1 | What does Forge cost? | Nothing is charged. The status doc lists "quotas, pricing, retention policy" under missing. The roadmap: "an open source replacement for the GitHub workflow, cheap enough to host for many small projects, with a free core". No pricing page, no plan, no payment. | docs |
| 2 | Who pays for what? | CI minutes: the account that owns the runner repository or machine ([journey 13](13-connecting-ci.md)). Storage and backend calls: the operator of the Forge service. GitHub API calls during an import: reported "by who paid for them". No single page states this split. | docs |
| 3 | What are the limits? | Storage: 100 MiB per stored object, 50 GiB and 4,000,000 objects per project, 100 GiB and 10,000,000 objects per account. Git history: 1 GiB per project. Git LFS: 1 GiB of objects per import. Repository size: 56,800 files per State for every operation ([journey 12](12-import-migrate.md)). Signed-out reads of a public project: 120 calls a minute per project. Terminal sign-in starts: 30 a minute for the whole service. Landing message: 1,024 bytes. Board note: 240 characters. Inbound push: 5,000 changed files. | source, docs |
| 4 | Where can I see my usage against a limit? | Nowhere. No web page and no CLI read shows storage used, objects or calls against the quota. | source |
| 5 | What happens at a limit? | `QUOTA_EXCEEDED`: "This project has reached its storage quota (50 GiB or 4,000,000 objects). Nothing was reserved." `RATE_LIMITED` with `retryAt`. `help limits`: "A limit refusal names the limit and the value you sent." and "Limits are set by the project owner; Forge never raises one on its own." | source, ran |
| 6 | Can I get more? | No route. The quota values are constants in the service's source. | source |
| 7 | What will change at the beta? | A gate on sign-up (30ce7f72), a spend guard that pauses new sign-ups when daily spend crosses the owner's line (13bccc12), remaining budget in agent replies (93907d28). Paid plans attach to organizations later (679171e6); the owner leans to "free self-host + paid hosted plan + sponsors" (aed285f0) and decides pricing "after real beta usage data; the beta runs free with quotas". | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J21-1 | S1 | **A person deciding whether to adopt Forge cannot find out what it costs or will cost.** No page says "free during the beta, within these limits; pricing comes later; self-hosting is free". The decision exists in planning; the sentence does not exist in the product. People will not move a team's repository onto a service whose price is unknown. | docs |
| J21-2 | S1 | **Usage against a limit is invisible until the refusal.** A project at 49 GiB gets no warning; the save that crosses 50 GiB fails. An agent mid-task gets `QUOTA_EXCEEDED` with no way to make room. Open Issue 93907d28 covers rate limits in agent replies; storage has no equivalent for people. | source |
| J21-3 | S2 | **The help says the project owner sets limits; the owner cannot.** "Limits are set by the project owner; Forge never raises one on its own." The storage and rate values are constants set by the service operator. A project owner told by an agent "ask the owner to raise the limit" has no control to do it. | ran, source |
| J21-4 | S2 | **Limits are documented in six places and listed in none.** Storage in source, history in the Git serving doc, LFS in the import doc, repository size in the source exchange doc, message and board sizes in the help. The table above is the first list. | source, docs |
| J21-5 | S2 | **Who pays is not stated** (journey 9, J9-5). With your own CI the largest cost of a busy project is on the owner's CI account, which favours Forge's story (fewer minutes), and nothing in the product says so. | docs |
| J21-6 | S2 | **Nothing can be deleted to get under a quota.** Storage counts "when a new object is reserved". No screen shows what uses the space (Lane snapshots, history, LFS, check logs) or offers to free it. Abandoned Lanes keep their saves. | source |
| J21-7 | S2 | **The object quota is easier to hit than the byte quota and harder to understand.** 4,000,000 objects per project: a person thinks in gigabytes. The refusal quotes both and does not say which one was reached. | source |
| J21-8 | S3 | **A paused sign-up has no message.** The spend guard will stop new accounts; what the visitor reads is undecided. | docs |
| J21-9 | S3 | **Self-hosting is the free plan and has no first page** (see [journey 37](37-running-forge-yourself.md)). | docs |

## Dead ends

- "How much storage am I using?"
- "Raise my limit."
- "What will this cost when the beta ends?"

## Naming and tone

- Limit, quota, budget, cap, envelope and floor are used for the same idea.
- The refusals are plain and say that nothing was changed ("Nothing was reserved."). That is the right tone to keep when money is added.

## What each persona needs

- **Agent, not person:** the remaining budget before it starts work that will hit it; a refusal that says whether waiting helps (rate) or not (quota); one sentence to pass to its person.
- **Person, not agent:** before sign-up, what is free and what is limited; in the product, usage against each limit with what is using it; at a limit, what to remove or whom to ask; later, a bill they can predict.

## Questions for the owner

1. What does the public page say about price before pricing exists: "free in beta within stated limits; pricing announced before any charge; self-host free"?
2. Is there a usage page per project and per account (storage, objects, history, and CI minutes from journey 9) in the beta?
3. Which limits can a project owner change, if any, and should the help sentence change to "set by the service"?
4. Should Forge warn at 80% of a storage quota, in Needs you and in agent replies?
5. What can a person remove to free space, and is anything removed automatically (old snapshots, logs of abandoned Lanes)?
6. When plans exist, is the unit the organization, the project or the agent seat? (Input to aed285f0.)
