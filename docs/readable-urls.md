# Hosted project URLs

Hosted projects use `/<handle>/<project-slug>`. Account handles are assigned at sign-in
from the Clerk username, then first and last name, then a random `user-…` name. Email
addresses are never naming inputs. Handles are lowercase, unique across accounts,
2–39 letters, digits or hyphens, with no leading/trailing hyphen. Application route
roots are reserved in `src/readable-urls.ts`. Collisions receive `-2`, `-3`, and so on.
Project slugs are assigned from project names and are unique within an owner.

Settings › You › Profile edits the account handle with live availability validation
and a URL preview. Account Settings also offers You. Settings › General edits the
project name and slug together; changing only the name leaves the slug unchanged.

`accountHandles` and `projectSlugs` retain previous names permanently. They cannot
be reassigned to another account or project. Resolving any retained pair, an old
`user_…/name~id` path, or a legacy `?project=id` link checks current project access
before returning its current URL identity. Missing and forbidden projects both
return null and render Project not found. The browser replaces its history entry
with the canonical URL. Work/source pins, deep-link selections and line anchors
survive the shared route codec. Alias records are hosted metadata; Work format is
unchanged.

`src/project-routes.ts` is the URL codec shared by web navigation, copy/share links,
and CLI/MCP agent links. `hostedProjectRoot` also creates the CLI hosting result.
CLI agent links refresh identity when authenticated. An offline caller with an
already readable saved binding can still construct a link from that binding;
renamed bindings resolve through permanent aliases when opened. Legacy ID-based
bindings need the existing account lookup to obtain a readable identity.

## Existing accounts and projects

Deploy the optional schema fields and functions before running the backfill. The
operator runs this from the deployed source checkout, with the existing Convex
operator credentials and Clerk configuration:

```sh
npx convex run urlsBackfill:run '{"cursor":null}'
```

Repeat that command with the exact returned `cursor` until `isDone` is true, for
example `'{"cursor":"accounts:25"}'` or `'{"cursor":"projects:"}'`. Forge uses the
development Convex deployment only. No backfill runs on deploy.

The action fetches 25 Clerk naming profiles per page and invokes the internal
idempotent `urlsBackfill:accounts` mutation, including accounts without projects.
It then reads 25 projects per page and invokes the idempotent cursor mutation
`urlsBackfill:page`. Existing assignments remain unchanged on replay. A failed
page can be retried with its original cursor. Restart from null after concurrent
Clerk account deletions to cover accounts shifted between offset pages; existing
assignments are preserved. Accounts created during the sweep receive handles at
sign-in. Run through the final project page before relying on readable links for
existing projects.

The local synthetic settings preview is `node scripts/qa-f-preview.mjs`, opening
`http://127.0.0.1:5196/dino/nanthai-forge/settings/you`. It renders the actual handle
control and settings shell with synthetic query answers, without a deployment.
