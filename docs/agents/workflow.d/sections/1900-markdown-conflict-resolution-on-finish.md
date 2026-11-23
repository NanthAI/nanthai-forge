### Markdown conflict resolution on finish

When finish syncs main into a native Lane and every conflicting path is
Markdown documentation, it writes a deterministic resolution instead of
markers. Two inserts at the same point keep both, main's first; an insert at
the edge of the other side's edited lines keeps both. Lines both sides edited
resolve only inside list items, table rows or blank lines: lines removed by
either side stay removed, then main's new lines, then the Lane's. When both
sides only appended text to the end of the same prose line (a sentence each),
the line keeps main's addition, then the Lane's. Other edited prose, deletes,
binary or mode changes, path clashes and any code conflict keep today's
behavior: finish stops with `status:"conflict"` and markers. Markers are never
written into a resolved file, and no side's new line is dropped.

**Shared lists that never conflict.** A project names its shared list files
(changelogs, registries, ignore lists) in the root `forge.json`:
`{"merge": {"union": ["lists/*.txt"], "fragments": ["packages/*/CHANGELOG.md"]}}`.
Where the line merge stops in a declared file, every conflicting hunk keeps
main's entries, then the Lane's new ones; an entry either side removed stays
removed and an entry both sides added appears once. `union` treats each line as
an entry; `fragments` treats each blank-line-separated block as one, so a
multi-line changelog section stays whole. A declaration counts only once it is
on main: the Lane being merged cannot add one for its own landing. It takes
precedence over the Markdown rule, applies wherever that rule does (finish
sync, hosted sync, compose and every recompose) and is recorded the same way
(`docsResolution` paths, same `rule` and `undo`). Binary files, deletes and
mode changes still conflict, and the result is plain text: a list whose syntax
needs a separator on every entry but the last (a JSON array) can still need a
fix after landing, which the landing check catches.

**A split document keeps raw edits.** When one side splits a doc (`NAME.md` becomes
headings plus `Entries:` lines over files in `NAME.d/`, see `src/doc-fragments.ts`) and
the other side still edits the old `NAME.md`, each raw hunk moves into the file that now
holds those lines, in either direction and wherever the Markdown rule applies. So the split
lands in one round. A hunk across two entry files, on the blank line between entries,
on an `Entries:` line, or touching a line the split itself changed stays a conflict. The
merged entry files must assemble to exactly the split page with the raw hunks applied, or
the conflict stays. The record lists `NAME.md` and the entry files that took the edits.
A recognised split never falls back to the keep-both rule: more than 500 entry files, more
than 4 MB of text, a non-file under `NAME.d/` or an `Entries:` folder outside `NAME.d/`
also stay a conflict. Compose fetches only the `.md` files directly inside the `Entries:`
folders. The save-time conflict notice decides with the same code (`splitConflict` in
`src/doc-split-remap.ts`), so it does not warn about a split compose will remap; the
remap's byte proof still runs only at compose. Conservative cases that stay a conflict:
a `./x.md` link in added text, a link added inside an existing code fence, deleting a
whole entry or the blank line between entries.

The `Sync main` checkpoint records the resolved paths and rule in its automatic
summary and undo instructions (`x undo` restores the Lane save before it); the finish receipt's `sync` has
`docsResolution:{paths,rule}`. A retried sync or finish replays the same bytes.
Native standalone `sync` still writes markers.

Hosted landings use the same rule (`src/native-docs-resolve.ts`) inside the
existing compose step, for the landing queue, batches and every recompose on a
new main: a queued entry whose only conflicts are Markdown docs recomposes and
continues to its check without an agent turn. The Candidate records
`docs:{paths,rule}`; the acceptance receipt and the landing's `acceptance` carry
`docsResolution:{paths,more?,rule,undo}` (a batch's shared State puts it on its
last receipt), and `undo` names the `revert` command and the paths to edit
instead. A hosted `sync` of a Lane onto main resolves the same conflicts and
returns `docsResolution` whose `undo` names the Lane's earlier head
(`show {state,path}` returns each file's earlier bytes). Explicit conflict
resolutions and stacked syncs keep markers. Queue path advice
(`wouldConflict`, `SYNC_REQUIRED`) ignores shared Markdown docs, since the
recompose merges them or reports an actual conflict. Clean compositions are
unchanged; a docs-only conflict costs the in-Convex merge one more text
calculation (one more object-descriptor read when it runs inline) instead of a
failed landing and an agent round, and bytes stay in R2.
The check that follows uses ordinary docs selection when the Lane changed only
Markdown. After an interaction retry, the runner recomputes the same resolution
before accepting a Markdown-only overlap as `docs` scope; the run's interaction
reason names the resolved paths.
