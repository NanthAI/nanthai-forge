# Journey 36: organizations, teams and transferring a project

A company or group that owns projects together: creating the organization, adding people, teams that work on several projects, moving a project between a person and an organization, and someone leaving. This journey is not on the list of Issue a0cf8c22; it comes from open Issues 1e474c35 (organizations), f16016e1 (ownership transfer) and b6588425 (the Team object), which the 2026-11-09 review asked to design "before the Phase 7 pages. They shape every page."

Walked: the teams, sharing, contributors and project lifecycle sources, the security and governance docs, and those three Issues. **Not walked:** creating a team or sharing with one.

## Steps today

| # | Step | What exists | Evidence |
| --- | --- | --- | --- |
| 1 | Who owns a project | One account. Settings → General "shows owner, visibility and creation date". URLs are `/HANDLE/PROJECT-SLUG`. | docs |
| 2 | Create an organization | Not built. | docs |
| 3 | Teams today | Account → **Reader teams**: "Create reader team", "Your teams", "Add team member", "Share with reader teams", "Team access saved.", "No reader teams yet." They "share a whole private import. Both the importer and the reader need current GitHub entitlement." They apply to read-only analysis imports, not to editable projects. | source, docs |
| 4 | People on an editable project | Access: owner and contributors, one at a time by handle or email ([journey 7](07-people-access.md)). Named readers: "Add reader", "No named readers." | source |
| 5 | Give a group access to several projects | Not possible. Each project is shared separately, person by person. | source |
| 6 | Move a project to another owner | Not built (f16016e1: "The owner can transfer a project to another user or a Team; the recipient accepts"). Renaming works: "Save project name and URL"; old links keep working. | source, docs |
| 7 | Someone leaves | Remove them from each project: "Contributor access removed." Their terminal sign-ins keep working on their other projects. Nothing lists what they could reach. | source |
| 8 | The owner leaves or loses the account | No second owner, no recovery route for the project. | docs |
| 9 | Company controls | None: no single sign-on, no audit export, no required second factor, no billing owner. Listed as later, commercial work in 1e474c35. | docs |
| 10 | Agents in an organization | Agents act as the account that started them. "Organization-level agent tokens come later." | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J36-1 | S1 | **A project has exactly one owner, and only that person can approve.** Every held landing, settings change and fork run waits for one account ([journey 32](32-maintaining-open-source.md), J32-4). If that person is on holiday, protected work stops; if they leave, the project has no owner. This is the first thing a team of three will hit. | docs |
| J36-2 | S2 | **"Teams" exists and means something else.** Reader teams share read-only analysis imports and depend on GitHub access. A person who finds "Your teams" under their account expects to add teammates to their project there. The planned Team object (people who work on a project) and organization teams will make three meanings unless this one is renamed or removed. | source, docs |
| J36-3 | S2 | **The URL is the owner's handle.** `/HANDLE/PROJECT-SLUG` ties a company's project to one person's name. Transfer will change the address; old links are kept for renames, and the same rule needs to hold for transfers. | docs |
| J36-4 | S2 | **Access is per project and per person, with no overview.** A person cannot see every project someone has access to, or remove a leaver in one action. | source |
| J36-5 | S2 | **The model is not decided, and every page depends on it.** Owner field (user or organization), roles (owner, member, billing manager is the proposal), base permission for members (none, read or write; default read), outside collaborators. Settings, Access, Home, URLs, limits and later billing all show it. | docs |
| J36-6 | S3 | **A restored project loses its access list.** "Project restored with its source and Work. Grant access and register runners again." Clear, and painful for a team project. | source |

## Dead ends

- A second owner.
- One group with access to five projects.
- Moving a personal project into the company.

## Naming and tone

- Team (reader teams today; project team and organization team planned), organization, owner, member, contributor, collaborator, reader. The role decision is owner / write / read; organization roles need the same care.
- "Reader team" is accurate and unknown to anyone from GitHub.

## What each persona needs

- **Agent, not person:** nothing new, except that its reach follows its person's memberships at every call (it does today for projects).
- **Person, not agent:** to create a shared home for projects, add a colleague once, give a team access to several projects, see and remove a leaver everywhere, and have more than one person able to approve.

## Questions for the owner

1. Is the organization model as proposed on 1e474c35 (owner, member, billing manager; base permission default read; outside collaborators per project)?
2. Can a project have more than one owner before organizations exist?
3. What happens to today's reader teams: renamed, folded into organization teams, or removed with the analysis imports?
4. On transfer, does the address change with a permanent redirect, as for a rename?
5. Is "remove this person from everything" one action for an organization owner, and does it list the secrets to rotate (as 1e474c35 proposes)?
6. Do organizations appear in the Phase 7 designs (owner switcher, organization page) even if built in Phase 8?
