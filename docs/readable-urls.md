# Hosted project URLs

Hosted projects use `/<handle>/<project-slug>`. Account handles are assigned at sign-in
from the username the person chose, else their GitHub login, else a random `user-…`
placeholder. Real names and email addresses are never naming inputs. An account on a
placeholder, or one whose handle was derived from a real name before this rule, is
asked once to pick a handle (web sheet, and `nforge login` prints the prompt); keeping
it counts as the answer. Pick or keep the handle on the web in Settings → Account.
Every device credential is refused handle changes, including unrestricted devices;
the retained CLI handle command gives that same web-settings remedy. Handles are
never renamed without that choice. Handles are lowercase, unique across accounts,
2–39 letters, digits or hyphens, with no leading/trailing hyphen. Application route
roots are reserved in `src/readable-urls.ts`. Collisions receive `-2`, `-3`, and so on.
Project slugs are assigned from project names and are unique within an owner.

Settings › You › Profile edits the account handle with live availability validation
and a URL preview. Account Settings also offers You. Settings › General edits the
project name and slug together; changing only the name leaves the slug unchanged.
Only the owner person changes them directly: a rename from an agent (any device
sign-in, the owner's own CLI included) is held for the owner person on the approve
page and applies exactly as granted: the request records the name and address it
was made against, the approve page shows that before and the resolved after, and a
grant after any other change to them fails with `WORK_STALE` instead of
applying something else. An old request replayed after a later change is refused,
never reopened, so each request applies at most once. A retried restore answers
with the same moved address as the first.

`accountHandles` retain previous handles permanently, and a handle alias is never
reassigned to another account. A project keeps its current slug and its 10 most
recent addresses in all (`projectSlugs`); old ones redirect to the current one, and
an address older than those 10 is released: it answers Project not found and is
free again. A project slug is never reassigned to another live project. Project
slugs are at most 100 characters (a longer custom slug is refused; a derived one
is cut to fit). A removed project (deleted, within its restore
window) keeps a record of its slugs but does not block them: a new, imported or
renamed project of the same owner may take them. Restoring the removed project then
keeps its slug if it is still free, or gives it the next free suffix and says so.
A request for one address never resolves to a different project: an address no live
project holds is Project not found. Resolving any retained pair, an old
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
renamed bindings resolve through the project's 10 most recent previous addresses
when opened; an older one is Project not found. Legacy ID-based
bindings resolve through the owner's Forge account handle.
