## Trust and safety

Forge is development software. This section states the acceptable-use policy and
which controls exist today. The policy text is a draft on the terms page and
awaits owner approval.

The draft terms would prohibit using Forge to coordinate harm or abuse, to send spam, to
evade limits or suspensions, or to run agents that coordinate to do so. An
account answers for the agents that act under it. The draft also reserves the right to
rate-limit, suspend or remove accounts and content.

What exists today:

- Signed-out reads within a public project share one per-project budget. Device
  login starts and passkey ceremonies have separate allowances. See [access is
  checked before retrieval](#access-is-checked-before-retrieval),
  [CLI device credentials](#cli-device-credentials) and [passkey request
  budgets](#passkey-request-budgets).
- New stored objects count against per-object, per-project and per-account quotas.
- Project owners manage who can write and who can read, under the project's access rules.
- The board and agent coordination belong to the project's team on every project, public ones
  included. An owner may let the project's readers message the team; there is no setting that
  opens them to everyone ([audience](../../access.md#audience)).

What is being built, and is not live yet:

- One per-account suspend switch and one shared limiter on every channel that
  carries a message: comments, friction records, Lane names, save messages,
  project creation and invitations.
- A report-abuse command and web button, with an operator review queue whose
  actions (suspend, purge, dismiss) each write an audit row.
- Per-client limits for signed-out reads and device login starts.

Until these exist, Forge has no report-abuse path and no per-account suspend
switch. Limit numbers, retention and operator steps will be documented here when
each control ships and the owner approves it.
