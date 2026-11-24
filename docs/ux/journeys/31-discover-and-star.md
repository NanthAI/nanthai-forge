# Journey 31 · Discover and star projects

A visitor can open Explore at `/explore`, search by name or handle, or follow a link to a public project or a person's or organisation's profile. Private and missing projects give the same answer. A signed-in person can use the same public page and open the project's workspace from it.

| Step | What Forge does |
| --- | --- |
| Find a project | Explore offers Active, Stars and Newest. Active sorts the listed projects by main health, recorded landings in the last seven days, then Forge stars. |
| See what is happening | The public front page shows main health, weekly landings and aggregate Lane counts. It shows the public plan and Lane titles according to the project's visibility settings. Code and history are available through the public code viewer. |
| Star a project | A visitor gets a sign-in link that returns to the public page. A signed-in person can give or remove their one star. The public count updates and the project owner can open **Who starred**. |
| Clone | The public page gives the sign-in link and then the clone and device-approval commands. A direct CLI clone without a signed-in device returns `SIGN_IN_REQUIRED` with the deployment's `nforge login` command and `recovery.nothingChanged: true`, without looking up the project or creating a destination. |
| Find a project as an agent | `nforge clone NAME` and [MCP lookup](../../agents/workflow.md) search the same cached Explore directory and give the project's URL and deployment-pinned clone command. Lookup works signed out. |

Public project stars follow the account (I42). Forge drops old public browser stars from the public Projects view and count. A person can star the project again from any browser. Private project bookmarks in the legacy Projects list still live in that browser. Source bookmarks are account-backed.

The site caches public responses for 30 seconds. The dormant R2 path ranks Explore from snapshot activity and Forge stars. Explore can show a reported time to main from the snapshot and otherwise says “not reported” or “not checked”; the weekly save-to-main aggregation is not wired yet. The fork action and its sign-in prompt depend on Item d1303286.

## Decisions

- The beta includes Explore, public profiles and account-backed counted stars. Crawlers may index public project pages, not Lane or diff pages. Verify crawler scope and public rollout on Item 8947a779.
- The public front page leads with the README and recent landings beside it; the code map is one click away (Item 8947a779).

The [security guide](../../security.md#downloads-and-public-viewing) describes public-read access and redaction. [Journey 16](16-outside-contributor.md) covers what a visitor can do after finding a project.
