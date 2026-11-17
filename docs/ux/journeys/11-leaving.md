# Journey 11: leaving or exporting

The GitHub mirror and getting data out.

Walked: `policy`, `nforge github status`, `help github`, `help git`, the GitHub status, backups, exchange and account-data sources, `nforge restore-work`, the Git serving doc and the governance doc. **Not walked:** connecting or disconnecting a mirror, a download and a delete (each changes the project or an account).

## Steps today

| # | Goal | Route | What the person or agent sees |
| --- | --- | --- | --- |
| 1 | Keep a copy on GitHub while using Forge | `nforge github connect PROJECT --repo OWNER/NAME`, then policy `githubMirror:{"autoPush":true,"repo":"OWNER/NAME"}` | Connect prints JSON with an authorize link and `status:"waiting"` (open Issue f15f1f1e: it does not open the browser or say what to do). After that every landing pushes one commit to the mirror; the landing message is the commit message (at most 1,024 bytes). GitHub `main` is read-only for contributors. (docs, ran: policy) |
| 2 | Check the mirror | Web → Settings → GitHub | "Not connected to GitHub", or four heads ("Forge main State", "Forge Git head", "Expected GitHub head", "Current GitHub head"), **Preview** and **Publish**, "Last synced main", and when the two sides differ: "Needs you — GitHub diverged; both heads retained". Now shows **Resume mirror** after a failed push. (source) |
| 3 | Check the mirror from the CLI | `nforge github status PROJECT` | Run with `.` on the Forge project, which mirrors on every landing, it printed `{"page":[],"isDone":true,"continueCursor":"…","splitCursor":null,"pageStatus":null}`. (ran) |
| 4 | Push by hand | `nforge github-sync ROOT [--dry-run or --push]` | Not walked. |
| 5 | Take the source with plain Git | `git clone https://DEPLOYMENT/git/HANDLE/SLUG.git` | Read-only clone, fetch and pull. A private project takes a Forge login token as the HTTP password. `git push` is refused with a message that changes go through Lanes. (docs) |
| 6 | Download source and Work | Web → Settings → Admin → Transfer & backups | "Stored checkpoints", **Download source and Work**, and "Archive contents & export" with three commands: `nforge work ROOT '{"action":"export-work","archive":true}'`, `nforge restore-work ARCHIVE.tar.gz NEW_DIRECTORY`, `nforge restore-native ARCHIVE.tar.gz NEW_DIRECTORY`. (source) |
| 7 | Export planning | Work → Planning → "Export planning history"; Initiative → "Export" | Not walked. |
| 8 | Export account data | Account → "Your Forge data" | "Export your ownership metadata or remove selected Forge resources. Source archives and encrypted SecretObjects use their own export controls." **Download metadata**. (source) |
| 9 | Stop the mirror | Settings → GitHub mirror → Pause or Disconnect (owner person) | Pause keeps the link and direction; Disconnect confirms first. `nforge github disconnect PROJECT` prints this web path and changes nothing. (docs, source; synthetic tests) |
| 10 | Delete the project | Settings → Delete project | Hidden at once, restorable for 90 days, then purged; **Delete permanently now** is separate. (source) |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J11-1 | S1 | **The export page gives commands the CLI refuses.** `nforge restore-work` answers: "nforge restore-work was part of the removed native mode; Forge runs hosted projects only". The same page lists `nforge work … export-work` and `nforge restore-native` from the same removed mode. A person who downloads an archive has no documented way to open it. | source, ran |
| J11-2 | S1 | **There is no "export everything".** Source leaves through Git or the mirror. Planning leaves through a web menu. Comments, receipts, check results and Lane records have no export. Open Issue 9b601e3b covers a full export. Settings pattern: export is self-serve, says what it contains, and is offered beside deletion. | source, ran |
| J11-3 | S2 | **The mirror status read says nothing.** An empty page with cursors, for a project that mirrors on every landing. Either the argument form was wrong (the usage says `PROJECT`) and the command should have refused, or the read has no row for an automatic mirror. Both end the same way: the command named for the job does not answer. The answer is in a different read: `nforge agent ROOT status '{}'` carries `githubMirror:{"status":"synced","repository":"OWNER/NAME"}`. | ran |
| J11-4 | S2 | **Six words for the GitHub link.** Mirror (docs, help), sync (`github-sync`, "Last synced main"), publish (web button), push (`--push`, `autoPush`), connect and binding. PRODUCT.md bans "sync" in product UI; here it means something other than updating a Lane from main. | ran, source |
| J11-5 | S2 | **The mirror page speaks in internals.** Four heads with names such as "Forge Git head" and "Expected GitHub head", and "both heads retained". An owner wants one sentence: the mirror is up to date as of this landing, or it is behind by N landings because of X. | source |
| J11-6 | S2 | **What a leaver gets on GitHub is not stated.** The mirror receives one commit per landing. Import says "Git history is separate". Nothing tells an owner whether the GitHub copy holds the full history they imported, the landings only, or both. | docs |
| J11-7 | S2 | **No export is offered at the moment of deletion.** The delete dialog is clear about what stops, the 90 days and that "Local copies and GitHub are unchanged", but it has no link to download the project first. | source |
| J11-8 | S3 | **A vendor name on the account page.** "Your Clerk identity …". Open Issue de67c77d moves sign-in off that vendor. | source |
| J11-9 | S3 | **The account data page is written as an operations console.** "Reconcile original operation", "Original operation selection", "Retained original requests", "Metadata and pin". | source |
| J11-10 | S3 | **`GITHUB_SYNC_*` and mirror stall states are explained only in the help topic.** "a mirror push did not finish; Forge main is unaffected and the next landing or nforge github-sync retries it." This is the right sentence; the web shows **Resume mirror** without it. | ran, source |

## Dead ends

- The archive commands (J11-1).
- `nforge github status` (J11-3).
- Turning the mirror off on the web (step 9).

## Naming and tone

- The position is clear and consistent in the docs: "Forge main is the source of truth; GitHub is a mirror and an import source." The web never says that sentence.
- "Transfer & backups" holds download, upload, import and export from two eras of the product.

## What each persona needs

- **Agent, not person:** almost nothing here. It needs to know a mirror failure never blocks a landing (the help says so) and that the landing message becomes a commit message with a size limit (the limits topic says so).
- **Person, not agent:** proof before committing to Forge that leaving is one step: what is exported, in what format, and that the GitHub copy is current. This journey is read before sign-up as much as at the end.

## Questions for the owner

1. What is the promise to a person who leaves: a Git repository with full history, plus one archive of everything else (Issue 9b601e3b)?
2. Does the mirror carry the imported history as well as the landings?
3. Should the mirror be controlled on the web (connect, pause, disconnect), or stay a CLI and policy matter?
4. Should the retired archive commands and the "Import archive" route be removed now, before the redesign?
5. Which word names the GitHub link in the product: mirror?
