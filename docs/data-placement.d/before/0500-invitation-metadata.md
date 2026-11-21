## Invitation metadata

`projectInvites` remains the single invitation store: target as typed, optional
handle-account binding, inviter, role, expiry, state, answer receipt and projected
mail status. The schema also accepts team-scoped rows, which share the indexed
recipient page. Older inbox callers still receive only project invitations. Email targets acquire no account binding until acceptance. Rows are
retained as metadata; no source, email body, token or attachment bytes enter them.
The staged team writer uses one row per request and the same store for relative
revocation generations. Direct team adds with an operation ID keep a digest-only
receipt in that store so retries can reconcile when the writer switch changes. Once a team has issued invitations, the team row holds a
generation counter and removing a member keeps that account's last removal
generation. The team deletion job purges these rows in the existing bounded
cleanup. No landing or access check reads team invitations.
`projectAccessOperations` keeps retry receipts, its compatible mail projection,
and one small invitation-generation counter per project that has a removed or
lowered member. That counter omits `operationId`; request writers require a
string operation id, so they cannot collide with it. Invitations record their creation generation; the existing
`projectActorNames` membership-provenance row records that recipient's removal
generation. These metadata fields replace a history scan or per-invitation
revocation writes; they contain no address-to-account lookup.
`invitationBlocks` is a recipient-owned account preference, indexed by recipient
and inviter and by address digest for delivery suppression. It is independent of
any project and deliberately survives a project purge; the project purge
inventory therefore has no project-owned row to remove. The recipient-only
handlers and negative tests guard its owner boundary. No automatic retention or
cleanup is introduced. Existing `deviceAttempts` rows hold fixed-size invitation
rate counters, reset in place, with no timer. The landing storage ratchet records
zero invitation/block bytes per landing. Runtime mail and invitation operations
are separately bounded in [access](../../access.md#scale).
