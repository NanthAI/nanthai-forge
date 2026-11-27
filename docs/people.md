# People and agent runs

A person's page (`/HANDLE`) says what that person and the agent runs they started did, day by day, and where. It
follows GitHub's norms and the [public identity rule](../DESIGN.md): people are Forge handles, agent runs are
`handle/run-name`, and nothing shows a name, an email, a device name or a machine name.

## What the person page shows

- **First and last activity**: the first and last action counted for the viewer.
- **Landings, Items closed, Lanes, reviews**: four figures; pressing one changes what the day grid counts. A landing
  counts for the person who submitted it, by hand or through one of their agent runs. An Item closed counts for the
  person whose planning edit set an existing Item's status to closed (once per Item per day; an Item created or
  imported as closed does not count). A review is a landing the person accepted after its check that someone else, or
  their own agent run, submitted.
- **Days**: one square per day, a column per week, Monday on top, at most 53 weeks (26 on a phone), starting at the
  first activity. Four ink steps scaled to the busiest day; no colour.
- **Busiest day, days with any, by agents**: from the same rows. "By agents" is the share of landings (or Lanes)
  that came from agent runs; for Items closed it is not shown, because an Item records who closed it, not which run.
- **Latest**: the person's four newest actions in the newest two projects the viewer may open: landings (Landed), and
  for the person themself or a viewer who may write in that project also open Lanes (In progress) and planning comments
  (Commented). Each row
  names the run and its model, or the person, and opens the receipt, the Lane or the Item.
- **Agents**: the runs the person started, newest first, with the model each declared (shown as declared, "model
  not declared" when it named none), Lanes, landings, first and last day. 25 a page; the total is counted from the
  rows read. Each run opens its page in the project it last worked in.
- **Where**: per project, landings, Items closed, Lanes, reviews and the last activity, marked public or private.
- **Only the person themself** sees **See it as others do** (the public view), **Devices and sign-ins** (each device
  by its code, never its name ("Device without a code" when an old one has none), with when its sign-in ends; the browsers signed in, marking this one; at most 10 of
  each, the rest on the Devices page, which "Manage" opens) and **Starred** (the newest 50 projects they starred that
  are still public). A starred list is never public. There is no "Edit your profile" yet: a profile has no editable
  field beyond the handle.

Use [Devices, sign-ins and Lane holders](guides/access.md) to check a terminal's scope or find its account settings.

## What an agent run's page shows

A run's page (Lanes → sessions → `PERSON/RUN`; `convex/projectAgentRun.ts`), shown for the project's owner and write members
only: the run's Lanes, how many of them it saved and landed, its planning comments, and the identity it reported.

- **Saves**: the save records on each of the run's Lanes (at most 200 counted per Lane, for at most 50 Lanes a read;
  past that the figure shows "+"). A save made after a holder handover still counts for the Lane's run.
- **Comments**: the count the day close made for this run in this project, over the run's days, through the last
  closed day, plus the listed comments on days not closed yet. The list below it shows the run's own comments from the
  person's Work change rows of the last 14 days, each linking to its Item; its hint says how many older ones it does
  not list (they are archived). The count shows "+" when it is a floor: a day's close stopped at a cap, the run has more
  day rows than the page reads, it has older Lanes than the first page and no known session start, or the list stopped
  before it reached the closed days.
- The page reads comments up to the moment it opened, so the person's other Work writes never re-run it; a new comment
  shows the next time the page opens. Its Lanes and saves stay live.

## Where the figures come from

Nothing here adds a write on the save, comment or landing path. Every planning edit and comment already writes one
Work change row (`projectCoordinationEvents`, `kind: 'change'`: actor, time, action; kept 14 days, then journaled)
and keeps its command (status, Item, text, the agent run that sent it) in `projectHostedRecordBodies` or its retained body.
Save records already name their Lane. `convex/personWork.ts` reads these.

- **Items closed and comments per run** are counted by the project's day close, from that day's change rows. An Item
  counts as closed only when its version before the put was not closed (one indexed read of that version's status in
  the hosted record store, or, for a project whose planning is only in the Work journal index, the version row before
  the put's own), so an edit that re-sends the closed status of a closed Item is never a close. When neither store has
  that version, the put counts as a close.
- **Latest** and the **agent page's saves and comment list** are read when the page is viewed.

Limits: planning work is never undercounted silently: when a close stops at its cap (1,000 change rows, 400 commands
or 4 MiB of command and Item-version reads), or its window reaches
past the 14 days of change rows Convex keeps (a project with no landing for over 14 days), the days it could not fully
count are marked partial on each person's day and on the project's Stats day, and the pages show the figure as "N+"
(its hover says older days are counted from what is still kept; nothing else on the page). A partial close also marks
everyone who can do planning work in the project (its owner and up to 100 writers) on the closing day, so a person
whose only planning work it left unread still sees "+"; that mark alone shows no activity. The one-time Lane backfill
(`convex/statsLanesBackfill.ts`) recounts only Lanes and keeps these planning counts and marks, so it is safe to run
at any time.

## Who sees what

The server filters; it never sends a row the viewer may not open.

| Viewer | Sees |
| --- | --- |
| Signed out, a device credential, or a signed-in person with no project in common | Public projects only; Latest shows landings only |
| A teammate (owner, writer or reader of a private project the person worked in) | Public projects, plus the private projects both are in, named "Private, you are both in it"; Latest adds open Lanes and comments in those private projects where the viewer may write (a reader gets landings only, as presence and the agent page give readers nothing of them) |
| The person themself | Every project they worked in (Latest with Lanes and comments in all of them), their devices and sign-ins, and their stars |

A removed project is never shown. A visitor's page comes from the cached public read (`/-/public/v1/profile/HANDLE.json`,
`convex/publicRead.ts`) and opens no Convex connection; a signed-in viewer's page asks `personDays.profile` once when
it opens (not a live subscription), and again only when they page through Agents. The person's own page also asks
`authSessions.list` and `publicDiscovery.myStarred` once each. Both read only the signed-in person's own records, so
they cannot show anyone else's, whatever page asks.

## Data and budgets

One `personDays` row per person per active UTC day ([data placement](data-placement.md)) holds that day's counts per
project (`src/person-days.ts`). The project's [Stats day close](run-evidence.md#stats) writes it: the close already
reads the day's receipts and landing rows; it adds the Lanes started since the project's previous closed day (one read
each, each filed under its own day, so a weekend or a Lane that crossed midnight UTC is counted) and one read and one
write per person active on each of those days. In the same window it reads the Work change rows (at most 1,000, about
0.3 KB each) and one command per planning edit or comment (at most 400, and at most 4 MiB read: one document is at
most 1 MiB, so very large Item bodies can never push the close past Convex's 16 MiB read limit) for Items closed and
comments, plus one Item-version read per put that sets an Item closed (two, and one Work index lookup per close, on a
project whose planning is only in the journal index). A landing
writes nothing extra; an idle project writes nothing. A project's day is counted once that day closes, which the
project's first landing of a later day triggers, so today shows from tomorrow. A close looks back at most 366 days and
keeps the newest 1,000 open and 1,000 closed Lanes of its window. A day left not measured (its close never finished)
is not a closed day: the next close reads from where that close would have, and marks those days partial, since their
landings were never read. The person-day writes are on the close's meter: a day with more people than one close can
write closes with the rest unwritten, marked partial. Days closed before this (Item a9ad21c9) are filled in by the
one-time `statsLanesBackfill` run, which runs a gap on through days left not measured.

- Row size: about 100 B per project-day plus about 40 B per agent run (at most 40 runs per project-day; more are
  counted, not listed), plus about 6 B for Items closed and comments and about 2 B per run that commented.
- Profile read: at most 366 days and 50 projects the viewer may see (one project read, one role read and one account
  read each), once per view. Private-only days and private projects do not use those caps up; the read stays bounded
  by scanning at most 3 pages of 366 rows and looking up at most 200 projects. A person with a full year of daily work
  across a few projects reads about 100–300 KB (up to about three times that when most of their days are private and
  the viewer cannot see them). Latest adds, for each of at most two projects, three ranges of 15 rows (receipts, open
  Lanes, the person's change rows) and at most four command reads per project (eight a view).
- Agent page: one save range per Lane shown (at most 50 Lanes, 200 rows each; about 15–50 KB a view at dogfood
  scale), and on its first page at most 32 day rows, 200 change rows and 40 command reads for the comments. The page is
  a live read: it re-runs when one of the run's Lanes or saves changes (as before), and on no other Work write, since
  its comment ranges end when the page opened (before, every Work write by the person in the project re-ran it while
  the run was active, each re-run reading up to about 100 KB).
- Idle: zero calls. Nothing on the page polls or runs a timer.
- Backfill (`convex/statsLanesBackfill.ts`, once per deployment, by hand): per project it reads its closed-day rows
  once (about 1–2 KB each, 40 per run) and only the Lanes of the gaps between them (never a closed day's own Lanes),
  and per gap day with Lanes it reads and writes one row per person. So the cost is closed days + gap Lanes + gap-day
  person rows, once; a rerun replaces the same entries and adds no rows. Each run spends at most about 6,000 Lane
  documents and continues itself; it never touches the landing path.

## Who did it on every row

The design system's `Who` (`web/src/ds/marks.tsx`, [DESIGN.md](../DESIGN.md) "Who did it") shows a person by handle
or an agent run as `run · model · for @person`, from the record's own `actor`, `agentRun` and `agentClient` fields;
`web/src/app/who-links.ts` makes the names lead to the person page and the run's page.
