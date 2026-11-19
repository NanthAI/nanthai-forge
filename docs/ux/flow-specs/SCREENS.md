# Screens

Every screen the flow specs touch. When two specs describe the same screen differently, the difference is settled here first.

| Screen | Purpose | Flow specs that touch it | States considered |
|---|---|---|---|
| Landing page | Explain Forge before any ask; one next step | 15 | ideal, reduced motion, walkthrough failed, slow, signed in, phone |
| Sign in | One handle field with passkey; GitHub below | 16 | ideal, passkey closed |
| Device approval | Approve a terminal once: code, name, reach | 16, 20, 25 | ideal, code mismatch, expired, idle device return |
| Home | Projects across the account; one cross-project inbox; status line per project | 01, 12, 16 | ideal, new account with setup decisions, loading |
| Needs me | The project's front page: Needs you, FYI, Loose ends | 01, 02, 05, 06, 07, 16, 18, 24, 28 | ideal, nothing waiting, loading, could not read, many decisions, incident line |
| Lanes | Open Lanes on the four stops; overlap notes | 03, 06 | ideal, nothing in motion, loading, offline, many Lanes |
| Lanes › History | Landed work with auto tag and Take it out of main | 03, 08, 29 | ideal, being taken out, loading |
| Lanes › To read | Landed changes the reader has not opened | 03, 04 | ideal, all read |
| Lane | One Lane: stops, Changes, Checks, Thread, History | 03, 04, 06, 07, 08, 21, 22, 32 | ideal, stopped holder, no holder, changes asked, refused save |
| Lane › Thread | One message list with questions, hand backs and the delivery line | 04, 07, 34 | ideal, empty, loading, not seen, withdrawn, send failed |
| Candidate review | Read a change by what needs eyes first; notes; approve or ask for a change | 04, 05, 28 | ideal, no check, diff loading, large or binary file, empty diff, load failed |
| Check result | The cause, suspects, failing tests and log of one check | 06, 18, 33 | ideal, main failing, not reported, never started, running, stalled |
| Approval page | Decide one held request with its exact scope | 05, 22, 29 | ideal, decided by someone else, withdrawn, stale save, read only, bulk, record failed |
| Hand-over sheet | The prepared prompt to give an Item to an agent | 02, 06, 07 | ideal, resume form, clipboard refused, preparing, no agent connected yet |
| Plan | The backlog: capture, order, groups, List, Tree and Board | 09, 10, 11, 12, 31 | ideal, empty plan, create failed, move failed, reorder by agent, long plan |
| Plan › Deleted | Items deleted in the last 30 days, with Restore | 10 | ideal, empty |
| Item | One Item: body, Done-when lines, thread, Lanes, sub-items, blockers | 02, 09, 10, 11, 32 | ideal, handed over not started, in progress, edit conflict |
| Initiative | A group's summary and progress line | 11, 12 | ideal, no Initiatives |
| Code › Files | The tree and a file at a version; who changed these lines | 13, 17, 22, 25 | ideal, empty project, large file, binary, not available, loading |
| Code › Compare | Changes between two versions | 13 | ideal, loading |
| Code › Search | Search over indexed files | 13 | ideal, no results, index behind |
| Code › Releases | Releases and their notes | 29 | ideal, first release, failing main warning, publish failed |
| Stats | Project figures: minutes, first-try rate, time to main, savings, trend | 12, 14, 26 | ideal, too few landings, not reported, loading, read failed |
| Settings › People & access | Members, roles, invitations, contributions | 19, 28 | ideal, only the owner, last owner refused |
| Settings › Landing & checks | Who approves, the check, protected paths | 18, 22 | ideal, never reports, empty protected list, preview loading |
| Settings › Secrets | Secret names, uses and readers | 21 | ideal, empty, save failed, use unknown |
| Settings › Mirror | The GitHub mirror and its direction | 17, 23 | ideal |
| Settings › Project | Export and leave; delete the project | 23 | ideal, archive preparing, failed, link ended |
| Account › Billing | Landings against the plan's limit | 14 | ideal, at limit |
| Account › Devices | Devices, sign-ins and live sessions | 20 | ideal, no devices yet, many sessions, owner's view, stop failed |
| Account › Your data | Export everything the person owns | 23 | ideal |
| Invitation page | The invited person's arrival | 19 | ideal, ended, email bounced, other account |
| Connect your agent | One command per agent app | 02, 16 | ideal, not connected yet, connected |
| Import from GitHub | Choose a repository, checklist, mirror question, progress | 17 | ideal, over limit, GitHub not connected, failed partway, empty repository |
| Incident page | What is degraded, what works, what waits | 24 | ongoing, ended, suspected, Forge unreachable |
| Explore | Public projects in an order with filters | 25, 26 | ideal, no results, loading, empty |
| Public project page | A public project's health, work, plan, stars and code | 25, 26, 27, 28, 29 | ideal, as of last landing, not found, not checked |
| Profile | A person's public projects and their own Starred list | 25, 26 | ideal, nothing starred yet |
| Fork and proposal | Fork a project and propose a change; follow it | 27 | ideal, paused intake, too many proposals, conflict, run declined |
| Triage | Outside proposals and reports for a maintainer | 28 | ideal, empty, many, bulk partly failed |
| Terminal: `nforge connect` | Preview, backup, apply and undo of an agent app's config | 16 | ideal, existing entry, invalid config |
| Agent replies (CLI and MCP) | `llms.txt`, first-contact reply, next Item, receipts, ask, hand back | 22, 24, 30, 31, 32, 33, 34, 35 | ideal, refusal with next and learn, incident field, empty plan, wait budget reached |
| Email | Batched email of decisions that wait on a person | 01, 05, 07, 17 | ideal |
