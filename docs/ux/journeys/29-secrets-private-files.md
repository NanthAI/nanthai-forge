# Journey 29: secrets and private files

Keeping credentials out of a project, getting them to a check that needs them, and keeping some files private. Issue a0cf8c22 lists "secrets for checks" under team and trust. [Journey 13](13-connecting-ci.md) maps how a check receives a secret; this file maps the rest: the scan at landing, Secret Objects and private files.

Walked: the security doc (secret scan, Secret Objects), the repository's own allow file, the Secret Objects source, the agent workflow doc (what a save leaves out), the governance doc and the open Issue 6bd7ddb1. **Not walked:** a landing with a finding, an allow entry, and creating or rotating a Secret Object.

## Steps today

The rebuilt project's **Settings → Secrets** is value-free: no values are entered
or shown. It explains current runner-secret passthrough and the intended sealed
Development/Checks sets, with a metadata-only unavailable stub until the gated
protocol lands. Secret Objects still exist on the account screen and do not feed
checks. Export/retirement and rotate-on-removal remain open on `41a0df87`; no
replacement store, machine-key setup or recovery ceremony is claimed here.
See [secrets for checks](../../security.md#secrets-for-checks).

| # | Situation | What happens | Evidence |
| --- | --- | --- | --- |
| 1 | An agent saves a file that looks like credentials | A save leaves out "ignored files and credential names", counted as `notSaved`. Then the landing scanner reads every changed file before upload. A finding refuses the save with `SECRET_FOUND`, stores nothing, and names path, line, kind and fingerprint plus the command to run after removing it (CLI and MCP reply alike). | docs, tests |
| 2 | A change that contains a credential reaches a landing | "Every hosted landing check scans the paths its composed Candidate changes … before project code runs." It looks for known shapes (private keys, cloud, GitHub, GitLab, Slack, npm, Google, Anthropic and OpenAI tokens) and "a random-looking value assigned to a secret-named key". "A finding fails the check like a failing test: the landing stops with `CHECK_FAILED`, and the notice names the file, line, kind and a 16-character fingerprint, never the value." | docs |
| 3 | It was a real secret | Remove and rotate it. If it reached a Lane save anyway (a shape the scanner does not know), the project owner opens that file on the Lane page, presses **Purge saved bytes…** and types PURGE. Its stored bytes are deleted. Reads, diffs, checkouts and Git fetches of them return `PURGED`, and the Lane's thread says who purged what and when. | docs, tests |
| 4 | It was not a secret | The notice prints the exact `{"fingerprint":"…","path":"…","reason":""}` entry per finding; paste it into `.forge-secret-allow.json` and write the reason. "Entries count only from main … so a change cannot allow its own finding: land the entry on its own first, then land the change." The file is on the Forge project's protected list, so that first landing needs the owner. | docs, ran |
| 5 | Who hears of an override | "Every landing that adds or edits an entry sends the project owners one alert on the landing alert channel (email or webhook, the same settings as stall alerts)", and the receipt carries `secretAllowAdded`. | docs |
| 6 | What the scan misses | "It does not see encoded or split values, text in skipped files, history that landed before it, or local (not hosted) checks." Files over 1 MiB and binaries are skipped. With a bring-your-own check, an allow-file change is reported as "unknown". | docs |
| 7 | A secret for a check | Names declared on the check; values live on the runner ([journey 13](13-connecting-ci.md)). | docs |
| 8 | Secrets held by Forge | Account → **Secret Objects**: "Create Secret Object", "Import a GitHub credential from .env", "Use a known Secret Object", "Rotate credential", "Manage capabilities", "Audit events", "Archived in your list". "Dotenv import creates a Secret Object and a value-free example file. It does not erase committed history or rotate the provider's credential." "Public visibility and contributor membership confer no secret discovery, use, modification or delegation authority." Checks "do not inject Secret Objects". | source, docs |
| 9 | A private file in a shared or public project | Not built. Owner decision on 6bd7ddb1: "paths inherit project visibility by default; only owner/maintainers may hide a path; readers see a hidden path placeholder (so diffs and conflicts still make sense)". The board notes a second, conflicting statement on who may hide a path. | docs |
| 10 | A person leaves the team | Access is checked at every write. Nothing lists the secrets that person could see. The organizations Issue (1e474c35) plans: "The UI points to the secrets the person could see, so they can be rotated." | docs |
| 11 | Check logs | A secret printed by a test goes to the CI provider's log; with `publicLogs:true` anyone can read it ([journey 13](13-connecting-ci.md), J13-8). | ran |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J29-1 | S1 | **Fixed (9d3c407d).** The landing scanner also runs at save, before any byte is stored, with the same allow entries from main. The owner can purge a save that leaked a credential the scanner missed. | docs, tests |
| J29-2 | S2 | **A false positive costs two landings and an owner's approval.** The allow entry must land first, alone; on a project that protects the allow file, that landing is held for the owner. An agent that adds a test fixture with a fake key stops for a person. The rule is sound (a change cannot allow itself) and expensive. | docs, ran |
| J29-3 | S2 | **Secret Objects are a product inside the product with no job in the main journeys.** They have creation, rotation, capabilities, delegation, audit and archive. Checks do not use them; deploy after landing (not built) is the stated future user. A person finds a secrets page that does not feed their CI (journey 13, J13-6). | source, docs |
| J29-4 | S2 | **The page speaks its own language.** "Secret Object", "broker status", "capabilities", "delegation", "discoverable". The archive note reads "Archiving changes your list only. Broker status and granted capabilities stay the same." | source |
| J29-5 | S2 | **Override alerts ride on the stall-alert settings.** The alert for a new allow entry goes to "the same settings as stall alerts". On the Forge project that is an empty email list and one webhook preset (journey 17, J17-2). The owner is the control here, and nothing confirms the alert has a destination. | docs, ran |
| J29-6 | S2 | **Private files are decided and unbuilt, and one detail is disputed.** Until then every file in a project has the project's visibility, including for the scan. A team with a private `.env.production` in a public repository has no answer but to keep it out of Forge. | docs |
| J29-7 | S2 | **Nothing helps after someone leaves.** No list of what they could read, no rotate reminder. | docs |
| J29-8 | S3 | **The scan does not run on local preflight.** "Local (not hosted) checks" are outside it, so an agent learns of a finding only after the hosted check starts. | docs |
| J29-9 | S3 | **Fixed (0fd5f69f).** The notice prints the exact allow entry for each finding, with an empty `reason` that the agent fills in; pasted unedited it allows nothing. | test |

## Dead ends

- Using a Secret Object in a check.
- Hiding one file from readers.

## Naming and tone

- "Secret Object" (also "SecretObject" on the account page), secret, credential, token, key. People say "secret".
- The scan's rule "never the value" is applied everywhere, including the alert. Good.

## What each persona needs

- **Agent, not person:** to be stopped before the save, with the line and the kind; for a fixture, the exact allow entry and the fact that it needs its own landing first.
- **Person, not agent:** one page for "secrets this project's checks and deploys use", with who can read each; an alert that reaches them when a scan is overridden; a way to mark a file private.

## Decisions

- Scan at save and refuse a detected credential before storing it. Keep the allow-entry path for false positives and the landing check as a backstop. After a real leak, rotate the credential; an owner can purge eligible save bytes in one action with a receipt (Item 9d3c407d). This is not a rewrite of main or a purge of backups, archives, chunked files or other Lanes' local caches.
- Sealed secrets are to be the one store for check and deploy secrets. CI gets one key; Secret Objects retire (Item a67effb2).
- The owner and the person who added a file may hide its path. The owner can undo the hide (Item 6bd7ddb1).

## Questions for the owner

- May an allow entry land together with the fixture it covers when the owner approves that landing?
