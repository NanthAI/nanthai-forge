### Current verified addresses in the rebuilt sign-in

Each GitHub sign-in replaces both the address and verified flag from its current
profile. If GitHub reports no verified address, Forge clears the old address and
flag, including on the linking path. A passkey-only account has no email-based
invitation authority. The browser identity resolver supplies these fields from
the already-read account row, never from a stale token claim.

New-account recipient lookup uses an exact normalized verified address and refuses
ambiguous matches. Explicit invitation acceptance rechecks that unique current binding;
no unverified address accepts an email invitation. The retained provider path remains
until its separate removal checklist is complete. Browser-session management
checks the live session and a fresh account-bound passkey or GitHub proof before
revoking other sessions; no session id supplied by a client selects another
account's sessions.

Team email additions retain the exact current verified native binding and the
configured legacy provider comparison. Different account matches grant nothing;
same-account matches proceed and the grant transaction rechecks the native
binding. Project membership uses the pending invitation path instead: retained
agent approvals and older project add APIs create invitations and the recipient
accepts. A completed invitation retry performs no directory lookup, grants no
membership and sends no second email. Legacy add APIs explain an ended invitation
instead of silently succeeding. Pre-change invitation rows require the original
operation's inviter to remain the project owner. Removing membership invalidates
that account's earlier open invitations atomically, without resolving pending
addresses in owner reads.
