# Flow Spec 19: Invite a teammate

**Goal:** A project owner wants a colleague working in the project with the least access that works, and the colleague wants to arrive in the right place.
**Covers:** R19

---

## Entry Points

- **From Settings:** People & access, Invite.
- **From an access request:** someone asked for access from a project's "not found" page with an invitation that ended.

---

## The Flow

### Step 1: Invite

**What they want:** To give one person access.

**What they see:** Invite: a field for a Forge handle or an email, and a role: read, write or owner, each with one line on what it can do.

**What they do:** Enter the person and choose a role.

**What happens:** Forge creates the invitation, sends one email, and shows the invitation link to copy, with when it ends.

### Step 2: The invited person opens it

**What they want:** To get in without guessing.

**What they see:** The invitation page: who invited them, the project, the role and what it allows, and Sign in to accept.

**What they do:** Sign in (or create an account) and accept.

**What happens:** They join with that role and land on the project's Needs me; the inviter sees it in FYI.

### Step 3: See who is in

**What they want:** To check access at a glance.

**What they see:** People & access: everyone with their role, when they joined, open invitations with their end date, and each person's agents counted under them.

**What they do:** Change a role or remove someone.

**What happens:** The change takes effect at the person's next call, is recorded, and offers Undo.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The invitation ended | The page says it ended and offers "Ask OWNER for access", which needs sign-in so the owner sees who asks. |
| The email bounced | The invitation shows the email could not be delivered and keeps the link to copy. |
| Signed in as another account | The page names the account and offers to switch. |
| No teammates yet (empty list) | People & access lists only the owner and the Invite action. |
| Removing the last owner | Refused, naming that a project needs an owner. |
| Sending failed | The invitation is not created; the form keeps its values and offers to try again. |
| Loading People & access | Member rows keep their space while loading. |

---

## UX Notes

- Roles match GitHub: owner, write, read. No maintainer role.
- *(Pending Decision — journey 36: organisations and teams; this flow covers one project.)*

---

## Prototype Scope

- The invite form with roles.
- The sent state with the copyable link.
- The invitation page for the invited person.
- People & access with members and open invitations.
- The ended-invitation and ask-for-access state.
