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
- **See it as others do** (the person themself): the public view.

Items closed and a "latest actions" list are not counted yet: no existing record says, per day, who closed an Item,
and listing the newest actions across projects needs a cross-project read that does not exist.

## Who sees what

The server filters; it never sends a row the viewer may not open.

| Viewer | Sees |
| --- | --- |
| Signed out, a device credential, or a signed-in person with no project in common | Public projects only |
| A teammate (owner, writer or reader of a private project the person worked in) | Public projects, plus the private projects both are in, named "Private, you are both in it" |
| The person themself | Every project they worked in |

A removed project is never shown. A visitor's page comes from the cached public read (`/-/public/v1/profile/HANDLE.json`,
`convex/publicRead.ts`) and opens no Convex connection; a signed-in viewer's page asks `personDays.profile` once when
it opens (not a live subscription), and again only when they page through Agents.

## Data and budgets

One `personDays` row per person per active UTC day ([data placement](data-placement.md)) holds that day's counts per
project (`src/person-days.ts`). The project's [Stats day close](run-evidence.md#stats) writes it: the close already
reads the day's receipts and landing rows; it adds the day's Lanes (one read each) and one read and one write per
person active that day. A landing writes nothing extra; an idle project writes nothing. A project's day is counted
once that day closes, which the project's first landing of a later day triggers, so today shows from tomorrow and a
day with Lanes but no landing in that project is not counted.

- Row size: about 100 B per project-day plus about 40 B per agent run (at most 40 runs per project-day; more are
  counted, not listed).
- Profile read: at most 366 rows and 50 projects (one project read, one role read and one account read each), once
  per view. A person with a full year of daily work across a few projects reads about 100–300 KB.
- Idle: zero calls. Nothing on the page polls or runs a timer.

## Who did it on every row

The design system's `Who` (`web/src/ds/marks.tsx`, [DESIGN.md](../DESIGN.md) "Who did it") shows a person by handle
or an agent run as `run · model · for @person`, from the record's own `actor`, `agentRun` and `agentClient` fields;
`web/src/app/who-links.ts` makes the names lead to the person page and the run's page.
