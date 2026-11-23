## Abuse reports

Any signed-in account can report a project, a message (a board note or an agent
coordination message), an Item comment or an account to the Forge operator. The
report goes to the operator, never to the project or the reported account.

- Web: **Report** on a comment or message in a discussion, **Report this project**
  at the end of the project picker, **Report** on a public project's page and
  **Report** on a person's page.
- CLI: `nforge agent ROOT report-abuse '{"target":"message","messageId":"…","reason":"…"}'`.
  `target` is `project` (the checkout's project), `message` (`messageId`),
  `comment` (`planningItemId` and `commentId`) or `account` (`handle`). A retry
  with the same `operationId` and the same inputs returns the same report; the
  same id with another target or reason is refused.

A reporter must be able to read what they report, by the same rule as the
reader of that content ([audience](../../access.md#audience)): a project by its
visibility; a board note by the board's rule (the team, or a contributor's own
notes and the replies to them); a coordination message by coordination's (the
team and a private project's readers, a discussion conversation the team only);
a comment by the discussion rule (a visitor of a public project sees only a
publicly visible Item). Anything unreadable answers exactly like a missing one.
Coordination messages already moved to the journal cannot be reported. A report
is a write, so a device needs the scope that write needs: project write for
project content, the account-write scope (all projects, write) for an account.
An account cannot report itself or its own content. Reports use the shared
account limiter: 10 a day for a New account, 30 for an Established one
([account limits](#account-limits-and-suspension)); a suspended account cannot report.

Cost: one write per report (the queue row), the limiter's counter write and a few
point reads; no read of the queue while idle and no cron. A report schedules an
operator alert through the alert webhook (the ntfy preset) and the alert email
(`FORGE_ALERT_EMAIL_TO`) unless one went out in the last ten minutes, so a burst or
a steady stream is one alert per ten minutes, never none. The alert names no one
and carries no report text.

### Operator review

The queue and the review are internal functions, run with the deployment key:

```sh
npx convex run abuseReports:queue '{}'                       # open reports, newest first, 50 a page
npx convex run abuseReports:queue '{"status":"dismissed"}'   # reviewed reports by outcome
npx convex run abuseReports:review '{"reportId":"…","action":"suspend","reason":"…","operationId":"<new uuid>"}'
```

A review retried with its `operationId` returns its first result and changes
nothing; a later review of the same report (say, suspend after dismiss) takes a
new one. Each queue row lists the `actions` its report supports.

Each report shows its target, the reported account and the reporter by handle,
the reason, and an excerpt of what was reported (at most 1,000 characters, kept
after the content expires). Look, then act:

- `suspend` turns on the account switch: every message channel refuses the
  account at once, its devices and browser sessions are signed out and its
  public projects are unlisted. Lift it with `projectBoardOperator:setSwitch`.
- `purge` removes the content: the reported board note is deleted (its body-free
  evidence row stays); the reported coordination message keeps its envelope with
  its text replaced, along with every copy of it (offered choices, each answer's
  chosen choice and resume prompt, a hand-back's `left`; the answer's own reason
  stays); a reported account or project loses every board note, one page now and
  the rest through the scheduler. Only the document reported is touched, never
  another one sharing its id. A reported Item comment is removed from every Work
  store and copy, its attachments included (their R2 deletes are retried until done;
  `artifactStorage:pendingDeletes` counts those still waiting, [removed artifact bytes](../../r2-storage-plan.md#removed-artifact-bytes)),
  and reads as "Deleted comment"; the
  Item and the rest of its discussion stay ([removing one comment](../../planning.md#removing-one-comment)).
  A decision comment's line also leaves the current Item body, by an audited
  edit. A comment whose Work row is in the journal archive, or whose words are in
  the stored base checkpoint, is purged by a scheduled action (the base one also
  rewrites the stored base and deletes its old objects), and its audit row says
  `done: false` until that finishes. A
  refusal before it wrote anything sets `failed` and returns the report to the
  open queue; a retry of the same review starts a failed run again. A whole
  Item purged after its deletion is removed from the stored base the same way
  ([whole Item in the base checkpoint](../../planning.md#whole-item-in-the-base-checkpoint)).
  After a base rewrite, a presigned link handed out earlier stops working once
  its bytes are deleted (5 minutes at most), and a CLI's local cache of the old
  base stays on that machine until its owner removes it.
  The report's excerpt is kept on the report row as the operator's moderation
  record, as GitHub keeps reported content for its moderators: only operators
  read it, and a project purge deletes it with the report.
- `dismiss` closes the report with no action.

Each action writes a `boardAudit` row naming the report, and the report keeps
its last outcome. A project purge deletes the reports about that project.
