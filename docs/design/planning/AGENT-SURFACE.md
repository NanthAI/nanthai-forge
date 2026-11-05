# P6 planning: agent surface (CLI, MCP, skill text)

Status: unshipped design input; see [README](README.md) for caveats and the synthetic-data note.

Builds on what exists: `planning` read, `put-planning-item`, `comment-planning-item`, `start {planningItemId}`. New verbs are thin; all writes keep `operationId` replay and `expectedVersion` CAS. JSON in, JSON out, one-line `summary` first.

## CLI: `nforge agent ROOT plan <action> '{…}'`

| Action | Args | Returns |
|---|---|---|
| `add` | `title` (only required), `initiative?` (id or unique title prefix), `parent?`, `type?`, `body?`, `fields?`, `notBefore?`, `after?`/`before?` (sibling id for position) | item `{id, version, order, derived}` |
| `list` | `filter?`: `alive` (default) · `waiting` · `blocked` · `dated` · `closed` · `all`; `initiative?`, `type?`, `field.<name>?`, `q?`, `groupBy?`, `cursor?`, `limit?` (≤ 100) | `{groups:[{key,title,line,items:[{id,title,type,derived,fact,order,initiativeId,parentId,laneCount,updatedAt}]}], nextCursor, workRevision}` |
| `show` | `id`, `comments?` (page), `history?` (page) | item + `work` chain (intent, lanes, check, landing) + comments page + history page |
| `edit` | `id`, `expectedVersion`, patch of `title/body/type/fields/notBefore` | item |
| `move` | `id`, `initiative?`, `parent?`, `before?`/`after?` | item; `POLICY_REFUSED` when reorder policy forbids |
| `comment` | `id`, `text`, `decision?: true` | comment |
| `close` | `id`, `reason` | item (`closedBy.hand`) |
| `abandon` | `id`, `reason` | item |
| `reopen` | `id` | item |
| `merge` | `id`, `into` | both items |
| `split` | `id`, `titles: string[]` | sub-items |
| `status` | `initiative?` | one-liners: `[{initiativeId, title, line, counts}]` |

`start '{"itemId":"…"}'` stays the way to begin work from an Item. `start` also accepts `initiative` (title prefix) so auto-tracking files the created Item correctly.

Short forms:
```sh
nforge agent ROOT plan add '{"title":"Import tarball instead of per-blob requests","initiative":"Release 2","type":"idea"}'
nforge agent ROOT plan list '{"filter":"waiting"}'
nforge agent ROOT plan status '{"initiative":"Release 1"}'      # "Release 1 close: 0 of 9 landed · 2 working · 1 waiting on <name> · 3 dated · 3 planned"
nforge agent ROOT plan comment '{"id":"ITEM","text":"Owner approved the deletes.","decision":true}'
nforge agent ROOT start '{"itemId":"ITEM"}'
```

## MCP

Two tools, read and write split so hosts can grant them separately.

- `forge_plan` (read): `{action: "list"|"show"|"status", …same args}`. Description (terse): "Read the project backlog: alive items by Initiative with derived status, one Item with its work chain, or one-line Initiative status. Paged. Status comes from Lanes, checks and landings, not from text."
- `forge_plan_write` (write): `{action: "add"|"edit"|"move"|"comment"|"close"|"abandon"|"reopen"|"merge"|"split", …}`. Description: "Capture or refine backlog Items. Only `title` is required to add. Writes replay by operationId; pass expectedVersion to edit. Reorder obeys project policy."

## Skill text (goes into the forge-agent skill; ≤ 25 lines)

```
## Backlog is Forge planning
The project's work list lives in Forge planning, not in a lead's log. Read `plan list` before choosing work; `plan status` answers "where is Release N?". Start work from an Item with `start {itemId}`; it links your Lane, and landing closes the Item with evidence. Never set status by hand.

Capture fast, refine later. `plan add {title}` is enough; put it under the Initiative named in the request ("note it for Release 2" → initiative "Release 2") in the same turn.

Writing a good Item (short, outcome first):
- Title: the outcome, not the task. "Forge stops leaking disk", not "Investigate disk".
- Body, only when known: why (one line), done when (observable), scope (in/out), links (paths, ids). No status, no dates, no cost.
- Type is a label: feature, bug, friction, decision, idea, chore, docs. Friction = a workaround you needed; always log it.
- Split when two parts can land separately or need different people; use `plan split`. Keep ≤ 7 sub-items.
- Comment instead of editing when you record a decision, a finding or a question; mark decisions with decision:true. Edit only to correct the Item itself.
- Duplicate? `plan merge {id, into}`; do not close with "dup".
- Waiting on a person? Say who and for what in a comment; the Item shows Waiting.
- Reorder only your own Items unless the project allows more.
```
