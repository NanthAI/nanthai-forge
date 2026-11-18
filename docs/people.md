# People and agent runs

A person's page (`/-/HANDLE`) says what that person and the agent runs they started did, day by day, and where. It
follows GitHub's norms and the [public identity rule](../DESIGN.md): people are Forge handles, agent runs are
`handle/run-name`, and nothing shows a name, an email, a device name or a machine name.

## What the person page shows

- **First and last activity**: the first and last action counted for the viewer.
- **Landings, Lanes, reviews**: three figures; pressing one changes what the day grid counts. A landing counts for
  the person who submitted it, by hand or through one of their agent runs. A review is a landing the person accepted
  after its check that someone else, or their own agent run, submitted.
- **Days**: one square per day, a column per week, Monday on top, at most 53 weeks (26 on a phone), starting at the
  first activity. Four ink steps scaled to the busiest day; no colour.
- **Busiest day, days with any, by agents**: from the same rows. "By agents" is the share of landings (or Lanes)
  that came from agent runs.
- **Agents**: the runs the person started, newest first, with the model each declared (shown as declared, "model
  not declared" when it named none), Lanes, landings, first and last day. 25 a page; the total is counted from the
  rows read. Each run opens its page in the project it last worked in.
- **Where**: per project, landings, Lanes, reviews and the last activity, marked public or private.
- **Only the person themself** sees **See it as others do** (the public view), **Devices and sign-ins** (each device
  by its code, never its name ("Device without a code" when an old one has none), with when its sign-in ends; the browsers signed in, marking this one; at most 10 of
  each, the rest on the Devices page, which "Manage" opens) and **Starred** (the newest 50 projects they starred that
  are still public). A starred list is never public. There is no "Edit your profile" yet: a profile has no editable
  field beyond the handle.

Not counted yet, because no existing record holds them and counting them would add a write on the save or comment
path: Items closed per person per day (no record says who closed an Item, per day), a "latest actions" list (no
cross-project read exists), and on the agent page the run's saves and its comments.

## Who sees what

The server filters; it never sends a row the viewer may not open.

| Viewer | Sees |
| --- | --- |
| Signed out, a device credential, or a signed-in person with no project in common | Public projects only |
| A teammate (owner, writer or reader of a private project the person worked in) | Public projects, plus the private projects both are in, named "Private, you are both in it" |
| The person themself | Every project they worked in, their devices and sign-ins, and their stars |

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
write per person active on each of those days. A landing writes nothing extra; an idle project writes nothing. A
project's day is counted once that day closes, which the project's first landing of a later day triggers, so today
shows from tomorrow. A close looks back at most 366 days and keeps the newest 1,000 open and 1,000 closed Lanes of its
window. Days closed before this (Item a9ad21c9) are filled in by the one-time `statsLanesBackfill` run.

- Row size: about 100 B per project-day plus about 40 B per agent run (at most 40 runs per project-day; more are
  counted, not listed).
- Profile read: at most 366 days and 50 projects the viewer may see (one project read, one role read and one account
  read each), once per view. Private-only days and private projects do not use those caps up; the read stays bounded
  by scanning at most 3 pages of 366 rows and looking up at most 200 projects. A person with a full year of daily work
  across a few projects reads about 100–300 KB (up to about three times that when most of their days are private and
  the viewer cannot see them).
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
