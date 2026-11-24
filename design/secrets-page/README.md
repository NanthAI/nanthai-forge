# Secrets page: names, what to rotate, proposals and holders

Design for slice 4 of Item 41a0df87 (sealed team secrets). Mock: [secrets-page.html](secrets-page.html). Open it in a browser from a checkout: the desktop page sits at the top (1440 px), every other state is under it, and two 390 px phone frames (dark and light) are at the bottom. The button at the top right switches the desktop between light and dark. It links the real system sheets (`web/src/ds/`); page-only classes start with `sp-` and map onto today's `web/src/app/secrets/secrets.css`. All data in it is sample data.

The page is value-free. It never shows, fetches or subscribes to a value, a ciphertext or a key. It changes nothing: every action is a command a person copies and runs on a terminal, where the CLI verifies and signs. Owner decision 5 (values through the CLI only) holds.

## Where it sits

Settings › Landing and checks › Secrets. The address stays `/settings/secrets`, so no link breaks.

- **Rail:** Secrets moves up to sit directly under Landing and checks. Its page count is the number of Needs-you rows (5 in the mock). A third rail level would be a new rail part, so the mock does not draw one.
- **Crumb:** the page title reads "Landing and checks › Secrets", with the parent as a link.
- **Landing and checks** gains one line that points here (rule 9), for example "Checks get 4 names from the Checks set. Secrets". It comes from the page's own read only when that page already makes one. Otherwise it is left out (state I).

## Layout

The page is a fixed frame (Settings, rule 3) with two columns from 861 px:

| Wide column | Narrow column |
|---|---|
| **Needs you** (only when something waits), **Names** | **Who can open them** |

At 860 px and below the page is one column in this order: Needs you, Names, Who can open them. Nothing scrolls sideways at 390 px. This was checked in Playwright at 1440 and 390 px in both themes (scroll width minus viewport = 0). `node scripts/check-ds-class-clash.mjs design/secrets-page` reports 0 clashes.

The page head:
- The sentence states the answer (see Copy).
- Right side: "shown at 14:02" (exact time on hover), **Refresh**, and the dashed agent chip `nforge secret list`. That is the documented command that gives an agent the same names and rotate list. Its output opens in place.

## Needs you (the one first stop)

This is one act-weight region with the act edge and the orange count. The count is the total of the rows below. It has three bands, in this order, and a band appears only when it has rows:

| Band | A row says | Its one command (copied) |
|---|---|---|
| **Take out removed computers** | `@dana left the project · K7QD-2MWX still listed in Development`, then "2 h ago · 1 computer". These are the server's removal markers that no re-key has converted yet. | `nforge secret unshare --marked` |
| **To rotate** | `DATABASE_URL env · Development`, then **To rotate** (clock) · "fp R2PA-9XNE (@dana) could open v7". A value flagged not reissuable adds "not reissuable: make a new key and set it". | `nforge secret set NAME` (`--file` for a file) |
| **Proposals** | the same facts, in the same order, as the CLI's apply prompt (next table) | **Copy apply** and **Copy reject**, each with the **full** 32-hex id |

Rules for the band:
- The rotate list is the CLI's list: live names whose value epoch is at or below a former computer's last epoch. A row leaves the list when the name gets a new value.
- Proposals appear newest first. There are at most 32 (the set's cap), so the band never pages.
- The region hint "each is done in a terminal; this page changes nothing" is the only standing line. It changes the decision in front of the reader, because the page itself has no apply key.

### Proposal words match the CLI (Lane f6ee1eec, decision eb8eb545)

The apply prompt in f6ee1eec reads:

`Apply change API_TOKEN (env) from fp 4HTB-W8CZ, proposed 12 min ago, id 3f9a12c04b7e5d1a9c2e8f60b3d417aa? [y/N]`

| Field | On the page | CLI word |
|---|---|---|
| operation | **change**, bold, first | `add` · `change` · `remove` |
| name | `API_TOKEN` in mono, escaped like `safeSecretName` | same |
| kind | `(env)` | `env` · `file` · `removal` (a removal has kind 3) |
| proposer | `from fp 4HTB-W8CZ`, then `@sam` when Forge knows the account | `from fp 4HTB-W8CZ` |
| age | `proposed 12 min ago`, exact time on hover | `proposed N min ago` |
| id | `3f9a12c0` (8 hex); the full id on hover and inside the copied command | full id |

The copied command carries the full id, so the id a person pastes is the id the prompt prints and the person can compare the two. The page reads the server's facts, which are not verified. The terminal re-checks the proposal on the device's verified view and signs only the exact one it showed (F1). Reject is offered beside apply because N3 lets a person reject with the same trust as apply. The proposer can always withdraw their own.

## Names

- One region with the bands Development and Checks (and Production once it exists).
- Columns: Name (mono, wraps, never cut), Kind (`env`/`file`), Changed (`v7 · 25 d ago`, exact time on hover), By (the handle of the signer's account, or **Not reported**).
- A name with a waiting proposal shows "1 proposal waits" in ink. A name on the rotate list shows **To rotate** (clock). Its command lives only in Needs you (rule 9).
- The band hints carry the one fact that changes the decision: Development is "what people and agents run with: `nforge run -- <cmd>` · new computers: Automatic|Confirm"; Checks is "what a check receives, and only the names it declares".
- The first 100 names of each set are shown, A to Z. **Show the next 100** makes one more read (see cost).
- On a phone a row stacks: name; kind · changed; by.

## Who can open them

People come first, each with their computers folded inside (rule 35). Machines come last. This follows the access-table pattern from `figures.css`.

- **Person row:** handle, then "owner · 2 computers", "write · 1 computer", or "left the project 2 h ago · 1 computer".
- **Computer row:** the device code (`dcode`, from its key). The viewer's own computers also show the name they gave them, quoted ("desk machine"); nobody else ever sees that name (rule 32).
- **How it holds the set:** "first holder" (genesis), "added by code", "joined automatically · not confirmed by code, so it changes nothing" (tofu), or **Needs you** · "removed, opens nothing new; taken out at the next re-key" (marked).
- **Waiting:** a computer that asked to join Development, with who asked and when, and "every holder is told, with Undo". In Automatic mode the next holder's terminal shares it, so nothing needs a person. Confirm by code is not wired in this CLI build, so no Needs-you band is drawn for it yet.
- **Checks:** owner computers and machine keys only. A machine is drawn with the dashed "nobody" avatar, the words "machine key", its code and who added it.
- **Footer:** "To take a computer out: `nforge secret unshare CODE`, then rotate what it could open." This is the only removal route. The page has no Remove key.
- Holders page at 25 people a set; the roster cap is 100 entries.

## States

| | State | What shows |
|---|---|---|
| A | After a removal (the mock's main page) | Needs you with all three bands, then Names and holders |
| B | Nothing needs you | no Needs you region and no orange; "18 secrets in 2 sets. Nothing needs you." |
| C | Never had any | "This project has no secrets yet." Empty Names: "Names appear here once someone sets the first one in a terminal." with `nforge secret set NAME`; the `.env` import line carries **Proposed** until slice 3 documents `nforge secret import` |
| D | Loading | the head draws at once; nothing for 100 ms; still bars after about 300 ms, six at most |
| E | Could not load | a notice (**Could not load**) with "Below is what this page last showed, at 14:02." and **Retry**; the last view stays, its hint "as shown at 14:02". Nothing reads again on its own |
| F | Read role | "Secrets are for people who can write." plus a link to People and access; no read is made (the query refuses readers, as the page does today) |
| G | A set nobody can open | **No value** (cross) "Nobody can open Checks. Its 4 names stay listed; the owner sets each again." |
| H | Worst case | see below |
| I | Pointer on Landing and checks | one line, only if it costs no extra read |

Refresh keeps the rows on screen and replaces them when the new read arrives. A key that started a read says so in its own label ("Refreshing…").

## Worst case (drawn in H)

- A 60-character handle, a one-letter handle (`@b`) and an emoji-first handle (`@🦊fox`). Initials are taken by grapheme.
- A secret name of 64 characters (wraps, never cut) and one of a single character (`X`, `K`).
- 787 names to rotate (100 shown, then **Show the next 100**); 32 proposals (the cap: "new proposals are refused until some are applied or rejected"); 400 names in a set (the head cap) shown 100 at a time.
- 61 people with 100 computers (the roster cap), shown 25 people at a time.
- A proposer or former computer whose account Forge cannot name: fp only, with "(not reported)".
- Counts of exactly 1 and 0 ("1 name", "1 computer"); a version of 12,840. Times are relative, with the exact time on hover.
- Device names are never right-to-left here, because only their owner sees them. Secret names are ASCII-only today (`safeSecretName`).

## Copy

The page sentence takes the first of these that is true:

1. "**N secrets need a new value** after @dana left." Add "N proposals wait for a person." when proposals wait. When the person is unknown: "after a computer was removed."
2. "**N proposals wait for a person.** 18 secrets in 2 sets."
3. "**1 removed computer still holds Development.** Take it out in a terminal."
4. "**18 secrets in 2 sets.** Nothing needs you."
5. "**This project has no secrets yet.**"
6. "**Secrets are for people who can write.**"
7. "**Secrets could not be loaded.** Nothing was changed."
8. "**Loading secrets…**"

Fixed state words: **To rotate** (clock), **No value** (cross), **Needs you**, **Could not load**. No other coloured words appear; "1 proposal waits" is ink. Banned words are absent (no "sync", "successfully", and so on).

## Read cost (the budget)

There is one new query, proposed as `sealedSecrets:overview { projectId, kind?, after? }`. It returns names-only JSON, and its `returns` validator has no `v.bytes()` field. The web calls it once with `convex.query` (one-shot), never with `useQuery`. That way no subscription ever holds a ciphertext row, and idle costs nothing.

| When | Calls | Rows read | DB read bytes | Sent to the browser |
|---|---|---|---|---|
| Page open | 1 query | auth and project check as today (about 2 docs); active set rows by `by_project_and_kind_and_active`, one per set that exists (2 today: Development, Checks); the project's contributors, one bounded page, to match roster account ids to handles; one profile per distinct holder account (typically 3 to 10, at most 100) | typically about 20 to 40 KiB per set row (names, roster, wraps and ciphertext all live in one row); **at most 512 KiB per set row** (the write cap), so at most about 1.1 MiB for 2 sets | typically 3 to 8 KB of JSON; at most about 60 KB (100 names a set, 25 people a set, 32 proposals) |
| Refresh or Retry | 1 query | same as page open | same | same |
| Show the next 100 names / 25 people | 1 query with `kind` and `after` | that one set row (plus handles for the new page) | at most 512 KiB | at most about 15 KB |
| Idle, hidden tab, return to the tab | 0 | 0 | 0 | 0 |
| Any write by anyone | 0 (nothing subscribed) | 0 | 0 | 0 |

The query does not read the history row, proposal rows or credential rows. Proposals come from the facts already kept on the set row. The rotate list and the holder labels are worked out from the set row's stored roster (formers' last epoch against each name's value epoch), the same derivation the CLI uses.

At today's scale (a few page opens a day per project) this is far under the Professional plan's included reads. Even 100 worst-case opens a day is about 110 MiB, against about 1.67 GB a day included. The page makes no write and no extra Convex call at idle.

**One change to an existing write:** `sealedSecrets:propose` already decodes the proposal. It also keeps `op` (1 to 3) and `kind` (1 to 3) in the pending facts on the set row. That is 2 small numbers per proposal, with no extra read or write, so the page can show operation and kind without opening the sealed proposal bytes. The page must never read `sealedSecrets:proposals` (sealed bytes) or `sealedSecrets:read` (payload).

**Rejected alternative:** a separate names-only projection row written on every head write. Reads would get smaller, but it adds a table (growth guard), a write per head write and a second copy to keep in step. Revisit only if billed reads show the set-row read matters.

## What this removes from today's page (web/src/app/secrets)

- The **unavailable** stub state and `SecretsGuidance` (the protocol is live).
- **Recent** (it needed the history row; changed-at and by on each name cover it).
- The disabled **New computers** radio group and the disabled **Remove** keys. These were pretend controls; the sharing mode becomes a fact in the Development band hint, and removal is the footer command.
- The proposed `nforge agent . secrets` chip. It is replaced by the documented `nforge secret list`.
- The "Proposed" mark on `nforge secret set`, now documented. `secretSetCommand`'s `--set checks` branch stays out until slice 5 documents Checks writes.

The page adds one query and two numbers on an existing record. It adds no table, no CLI command and no error code.

## Decisions for the lead

1. **Naming the removed person.** A former roster entry carries only a hashed account id. Once the person has left, their handle cannot be found from contributors.
   - **Recommended:** `markRemovedAccount` keeps the public handle beside the marker. The re-key step carries it into a small server-owned `formerHandles` list on the set row, bounded by the roster's former cap, so "after @dana left" works.
   - Without it, rows and the sentence fall back to "fp R2PA-9XNE (not reported)" and "after a computer was removed". Both are drawn.
2. **Needs me.** This slice does not add secrets to the top bar's Needs-you count, because that would need a field on the live per-project record. The rail page count on Secrets and the page's own first stop carry it. Recommended: leave it for a later Item, or lead decides now.
3. **Age wording.** The CLI prints minutes only (`proposed 4320 min ago`). The page uses relative time ("3 d ago"). Recommended: the CLI uses the same relative format, so a person comparing the two sees the same words. It is a one-line change in f6ee1eec's `applySummary` if that Lane takes it; otherwise the page prints minutes too.
4. **Placement.** The crumb plus rail order plus pointer line (above) is the recommendation, with no address change. The alternative, a third rail level, needs a new rail part.

## For the builder

- Rebuild `web/src/app/secrets/` from this mock: extend `secrets-model.ts` to the overview shape (proposals, markers, waiting, former), and map `sp-` classes onto `secret-*` in `secrets.css`.
- Server: `sealedSecrets:overview` (write role, names-only validator) and the 2 facts on `propose`.
- Guards to add:
  - the overview's return validator contains no `v.bytes()`;
  - the web bundle references neither `sealedSecrets:read` nor `sealedSecrets:proposals`;
  - the web calls the overview one-shot (no `useQuery`).
- Tests:
  - the rotate derivation matches the CLI on the same fixture;
  - a reader is refused;
  - the copied apply command carries the full id;
  - no sideways scroll at 390 and 1440 px in both themes (`tests/ds-stress-browser` pattern).
- Check it rendered against this mock; an Opus review follows (plan 2c7c9dee, S4).
