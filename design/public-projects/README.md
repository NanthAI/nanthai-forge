# Public projects: explore, project page, profiles, star and sign-in

Design for Item 8947a779 (stage B line, plus Q16 from 581bd373). Mock: [public-projects.html](public-projects.html). Open it in a browser. The keys at the top right switch between light and dark and between sample and worst-case data. Section 6 shows every page in a 390 px phone frame. The mock links the real system sheets (`web/src/ds/`, `web/src/public/person.css`); page-only classes start with `pp-`. All data in it is sample data. It adds no new visual direction: every part is a piece that already exists in `public.css`, `core.css` or the profile, arranged differently.

## Pages

| Page | Layout | Change from today (`web/src/public/Discover.tsx`) |
|---|---|---|
| **Project** `/HANDLE/PROJECT` | Head: owner/name, Public, the sentence, then license · since · forked from, then the keys Star, Fork, Share and **Clone** (the one primary). Standing line. Section strip **Overview · Code · Plan**. Then two columns: the **README** in the wide column; **Recent landings**, **About** and **Open Lanes** beside it in a 372 px column. On a phone the order is head (Clone first, full width), standing line, strip, README, landings, About, Lanes. | Q16: the README comes first and the landings sit beside it. The code is one press away as **Code**, which replaces the "Browse the code" key. The glance block becomes the head's sentence. **Next** and **Initiatives** move to the **Plan** section, which shows only when the plan is public. About loses the Main row, because the sentence already says it. |
| **Explore** `/explore` | Page sentence, then one region: find, Active · Stars · Newest, the count, then the project table (Project, Landings 7 days, **Time to main**, Main, Stars), then the pager with **Next 50**. | Adds the time-to-main column and a pager. The hint names the full order. |
| **Person** `/HANDLE` | Today's profile (Item 6a251b23): head, the four figures and the day grid, Public projects, Latest. | The public projects list uses the same table as Explore. |
| **Organisation** `/HANDLE` | The head with the organisation mark, **Public projects** first (most active first, 10 at a time), then **This week** across its projects: landings, open Lanes, main passing (n of m), stars. | Members are not listed (decision 4). |

There is nothing on these pages for a visitor to act on, so they have no first stop and no act edge. The sentence carries the answer.

## The star and the sign-in step

- **Star** (mock section 5A). The control is the existing `.btn.star` and `.star.in-row`. It has these states: signed out, not starred, starred, saving (one write; the key is disabled), and refused (one line under it). The count is exact below 100,000; above that it shows 128.4K, with the exact number in the key's label. The owner sees **Who starred · N**, which pages 25 handles at a time (5G). An agent session is refused with `STAR_PEOPLE_ONLY`, and nothing changes (5H). There is no star command.
- **Signed out** (5B–5D). Star, Fork and Clone each open one sheet titled with the action ("Sign in to fork tidewater"). It has one line saying nothing happened, **Sign in** (primary) and **Not now**. Sign-in returns to the same page with that key focused. It never stars, forks or clones by itself.
- **CLI** (5F). `nforge clone` without a signed-in device refuses before any request is sent. It names the one step (`nforge login SITE`) and says nothing was copied. Agents get the same reply as JSON: `code: SIGN_IN_REQUIRED`, `nothingChanged`, `next`. The wording and code are marked *Proposed*.

## Read cost: crawlers and signed-out visitors never reach Convex

Every public page is one **snapshot** object in R2, written when something changes (next table). The site Worker serves it from the edge cache. On a miss it reads R2, never Convex, and writes the snapshot into the page as static HTML (README, facts, rows), so crawlers index the text and the app takes over without a second fetch.

| Page or action | Visitor | Reads | Convex calls | Bytes |
|---|---|---|---|---|
| Project page | crawler, signed out | edge hit, else 1 R2 GET of `project/H/P.json` | **0** | ≤ 64 KB (README HTML up to 48 KB, 6 landings, facts) |
| Project page | signed in | the same, plus the existing star lookup for 1 project | 1 query (exists today) | + < 1 KB |
| Explore, one order and page | crawler, signed out | edge hit, else 1 R2 GET of `explore/ORDER/N.json` (50 rows) | **0** | ≤ 16 KB |
| Explore | signed in | the same, plus the existing star lookup for the 50 shown | 1 query (exists today) | + < 2 KB |
| Explore search | anyone | one R2 file per two-letter prefix of handle or name, read on the second typed letter | **0** | ≤ 20 KB a prefix |
| Profile, person or organisation | crawler, signed out | edge hit, else 1 R2 GET of `profile/H.json` | **0** | ≤ 24 KB |
| Code section | anyone | the existing public code reads (unchanged; on 6a60e89a) | as today | as today |
| `sitemap.xml` | crawlers | 1 R2 object, rewritten when the list of public projects changes | **0** | grows with projects |
| Star sign-in, fork or clone sheet | signed out | nothing: a static sheet | **0** | 0 |
| `nforge clone`, signed out | CLI or agent | nothing: refused on the device | **0** | 0 |
| Star or unstar | signed in | the existing one-transaction write | 1 mutation | — |
| Who starred | owner | 1 paged query of 25, only when pressed | 1 query | ≤ 2 KB |

Idle: with no change there are no writes, no reads and no timers.

**Writes, on change only.** A change marks the project dirty and schedules one rebuild. Further changes inside the next 60 s join it, so each project rebuilds at most once a minute.

| Change | Rebuilds | Reads per rebuild | R2 writes |
|---|---|---|---|
| A landing on main | the project snapshot and its rows in each order | project row, activity summary, 6 history rows, plan summary; the README and license only when the landing changed those paths | 1 to 4 |
| A star or unstar | the project's count and the Stars pages that hold it | the project row, then the rows that moved rank, read from an index | 1 to 3 |
| Made public or private, renamed or listed | project, profile, the order pages it enters or leaves, the search prefixes and the sitemap; when made private, its objects are deleted and the edge copy purged | bounded by pages, never by rows | ≤ 10 |

- **Cost.** R2 list prices are $4.50 per million writes and $0.36 per million reads; edge hits are free. At most 4 writes per landing comes to at most $0.018 per 1,000 landings. 1,000 cold views cost $0.00036. Convex calls: the rebuild adds 1 scheduled action and 1 bounded query per project per changed minute. Today the edge fills from Convex on every miss: once per 30 s per location per page, plus the explore activity note written on a read. Busy pages therefore cost fewer calls than today, and idle pages cost nothing. At doubled scale, writes grow with landings, not with visitors.
- **This week ages without a change.** A snapshot carries day buckets with their dates, and the Worker counts the last 7 days when it serves the page. The shown numbers are therefore right even for an idle project. The Active order itself refreshes only on the next change anywhere; that is acceptable because the shown numbers are right.
- **Freshness after making a project private.** Its objects are deleted at once and the edge copy purged. A location that cached it may serve it for up to its period (30 s today) unless the purge reaches it first.

## Decisions for the lead (recommended first)

1. **README source.** `.nforge/home.md` wins when present; otherwise `README.md`, then `README`, case-insensitive, at the root of main. Rendered with the comments' safe Markdown. Raw HTML is dropped.
2. **Images.** Project images (relative paths) load through the public code reads. External images (badges, hot links) are not loaded. Each shows as its alt text, linked, with the host in its hover text. This leaks no visitor address to third parties and needs no proxy. *Otherwise:* an image proxy that Forge pays for.
3. **Size.** The rendered README is stored up to 48 KB. A longer README shows "This file is N KB; the first 48 KB show here" with **Read the rest in Code**, so detail stays one press away.
4. **Organisation members** are not listed at the beta. Membership becomes public only when a member chooses it, as a later Item.
5. **Time to main** is the median time from save to main for this week's landings, measured by Forge. It shows *not reported* when unknown and *not checked* when main has no check.
6. **Sign-in never acts by itself.** The visitor returns to the page and presses again.

## For the builder

- Reuse `phead`, `pstate` (Standing, `of="public"`), `pframe`, `.md`, `.row.tl.pub`, `.kv.about`, `pstops`, `xrow`, `.btn.star`, `.star.in-row`, Sheet, `.cmd`, `pre.out`, `.notice`, `.empty`. The new page pieces are the section strip (`pp-tabs` in the mock), the five-column `xrow` with time to main (`pp-x`), and the landing row that keeps its grid at phone width.
- Found while drawing the worst case: `.xrow .pjn .ow { min-width: 5ch }` leaves a gap after a one-letter handle (`q   /x`). Fix it in `public.css` with the build.
- Draw the worst case in the browser tests: a 39-character handle with a 100-character slug, a one-letter handle and name, right-to-left and Japanese text, an unbroken URL, a wide table, a README over 48 KB, 128,400 stars, and counts of 0 and 1. Check light and dark at 1440 and 390 px with no sideways scroll. Mock check (this Lane): 0 overflows in 24 renders, and 0 design-system class clashes (`node scripts/check-ds-class-clash.mjs design/public-projects`).
- Removes or merges: the "Browse the code" key (replaced by Code), the glance block (now the head's sentence), the About Main row, Next and Initiatives on the front page (moved to Plan), and the Convex fill of public JSON on an edge miss (replaced by R2 snapshots).
