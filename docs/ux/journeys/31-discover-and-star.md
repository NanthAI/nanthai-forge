# Journey 31 · Discover and star projects

A visitor can open Explore at `/-/explore`, search by name or handle, or follow a link to a public project or a person's or organisation's profile. Private and missing projects give the same answer. A signed-in person can use the same public page and open the project's workspace from it.

| Step | What Forge does |
| --- | --- |
| Find a project | Explore offers Active, Stars and Newest. Active sorts the listed projects by main health, recorded landings in the last seven days, then Forge stars. |
| See what is happening | The public front page shows main health, weekly landings and aggregate Lane counts. It shows the public plan and Lane titles according to the project's visibility settings. Code and history are available through the public code viewer. |
| Star a project | A visitor gets a sign-in link that returns to the public page. A signed-in person can give or remove their one star. The public count updates and the project owner can open **Who starred**. |
| Clone | The public page gives the sign-in link and then the clone and device-approval commands. A direct CLI clone also requires a signed-in device. |
| Find a project as an agent | `nforge clone NAME` and [MCP lookup](../../agents/workflow.md) search the same cached Explore directory and give the project's URL and deployment-pinned clone command. Lookup works signed out. |

Public project stars follow the account (I42). Forge drops old public browser stars from the public Projects view and count. A person can star the project again from any browser. Private project bookmarks in the legacy Projects list still live in that browser. Source bookmarks are account-backed.

The site currently caches public responses for 30 seconds. The existing Explore ranking has no time-to-main signal and refreshes each project's activity summary when the public project page is read. On-change materialisation and R2 delivery are tracked by 6a60e89a. Crawler scope and rollout remain on 581bd373, question 73. The project front page still needs a README or `.nforge/home.md` and license, and the fork action and its sign-in prompt depend on d1303286.

The [security guide](../../security.md#downloads-and-public-viewing) describes public-read access and redaction. [Journey 16](16-outside-contributor.md) covers what a visitor can do after finding a project.
