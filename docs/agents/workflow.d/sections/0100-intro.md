Find a public project with `nforge clone NAME`. Pass a name, slug or `handle/slug`.
The lookup searches one cached Explore page and puts an exact `handle/slug` first.
Each match has a public project URL and a clone command. The reply also includes
the sign-in command. The `more` field means Explore has additional listings
beyond the page searched. Use `nforge clone --find NAME`
for a literal name that starts with a hyphen or looks like a URL.

For MCP before opening a checkout, run `nforge mcp --public` and call
`forge_find_project` with `{"name":"NAME"}`. Lookup is available signed out.

Cloning, fetching and source downloads require `nforge login`, including public projects.
Public web pages and rendered file views stay open; a project's GitHub mirror is the
anonymous clone route when available.

Use Node 24.22.1+ (24.x). `nforge agent --help` lists verbs;
`nforge agent ROOT VERB [--MODE] --help` lists parameters. Use
`--command-file FILE` for awkward JSON. The package ships optional,
self-contained `skills/forge-agent/SKILL.md` for recorded Work or graph context;
install it in your agent's skill directory. Ordinary file questions need no
workflow guidance.

New default folders made by `start` use `<title-slug>-<first 8 of Lane id>`.
From a clone they live in `ROOT.forge-client/lanes/`. From a Lane they open beside
it. The receipt gives the full Lane id and folder path. Existing folders and retries
keep their paths. Pass `path` to choose a folder. When a shortened name is occupied,
the folder uses the full id. If no title is available, the slug is `lane`.

Landing documentation calls the accepted destination Channel `main`; a receipt's target Channel refers to that same destination, including when the project names it differently.

A hosted finish replays the outcome for the same `operationId`. After a terminal
failure on unchanged saved source, use a new explicit ID or `retry:true` with
`reason:"flake"`, `"main-moved"`, `"infra"` or `"other"`. The new attempt
composes retained inputs on current main, skips saving and records the superseded
failure. Shorthand finish returns the failure and an exact retry command.
Acceptance reuses a passed check-only Candidate/run while main and source match.
Finish reconciles a completed asynchronous checkpoint before capturing changes.

Terminal failure returns `next:{action:"finish", ...parameters}` and `command`;
compatibility fields `retry` and `retryCommand` match. Parameters retain the
complete original selection, set `retry:true` and `reason:"other"`, and omit the
failed `operationId`. `replayParameters` identifies the immutable original.
CLI stderr prints the command; CLI and MCP share the envelope. Older releases use
`next:"retry"` with the same compatibility fields. Consumers may follow either
or report `submission.phase:"terminal-failed"` as the actual failure.
Conflict receipts supply one recovery continuation. Edit the named hunks first;
land/save reject them locally before compose/check, with zero added Convex calls.
Resolve accepts the Lane root or a subdirectory; separator-only text is valid. Recovery preserves check-only intent and check pins.
When the conflict was made from the folder you run in (your own Lane checkout at the saved head the conflict used), that folder becomes the resolution Lane in place: main is merged into its whole tree with markers in the listed files, its marker and conflict record name the resolution Lane and its origin, and you resolve, check and land from the same folder. Unsaved edits on paths the merge leaves alone stay in place. Text edits made after sync's save go into the conflict draft on the Lane side. The `folded` receipt names the original copies in `FOLDER.forge-client/resolution-folded/ID/`. Edits that cannot be rendered as text hunks still have their copies named in `kept` under `FOLDER.forge-client/resolution-kept/ID/`. Otherwise (run from the clone root, a different folder, or a folder saved again since) the resolution opens with the whole tree as a sibling folder (`ROOT.forge-client/lanes/ID`, or `FOLDER-ID8` beside a Lane folder at a chosen path), never nested in a Lane folder; `open` and `start` from a Lane folder place new Lanes the same way. The receipt's `workIn` line (printed on stderr) names the folder to work in now and why (a folder behind the Lane's save says the Lane has a newer save, never that the folder was saved again); for a new folder it also says the folder holds the Lane's saved head merged with main, and that the old folder and its unsaved edits stay where they were. Commands that still name the original Lane from the in-place folder follow the resolution instead of composing the original again. From any folder on this machine, `save`, `checkpoint` and `preflight` with the original Lane id run on the resolution Lane in its folder (stderr says so), `land` with it runs in that folder, `resolve`, `land --withdraw` and `wait {"peer"}` with it act on the resolution Lane, and other refusals of the old id (`HOSTED_CHECKOUT_REQUIRED`) and `status` (`continuesAs`) name the resolution Lane id and folder. A sync conflict of your own resolution Lane (main moved again before it landed) puts the new draft in that same Lane, one version on, in the same folder: no second resolution Lane, the original Lane it was made for stays its origin, and its next `resolve` is a new operation. This is for a plain `sync` onto main by the Lane's own agent; a sync onto a Candidate, or one while an early predecessor resolution is open, still drafts a sibling. A live landing of the earlier draft is superseded, and that draft's moved-aside copies stay under `ID.HEAD12/` (the earlier draft's head) beside the newer ones. Replaying the earlier draft's `sync` or `resolve` changes nothing and names the current step (`earlierDraft: true`). Chains from older servers still follow: a folder resolved in place again remembers the earlier Lanes of the chain, so any of their ids finds the current resolution Lane (local files only, no server call). A retry of such a command with the same `operationId` replays the operation as it first ran, on the Lane it ran on. Once you edit every listed file free of markers, `land --save` saves that edit as the resolution (it runs the retained `resolve`, says so on stderr) and lands the resolution Lane, as fixing and pushing does in Git; a fresh `operationId` you pass becomes that landing's id, and a local refusal before any hosted step (such as a direct `finish`'s `RESOLUTION_REQUIRED`) gives its `operationId` back, so the same id can run the corrected command; a direct `finish` naming the original Lane refuses with `RESOLUTION_REQUIRED` and the one `resolve` command instead of landing its pre-resolution head. Files that still hold markers keep the server path (a retry after main moved can compose cleanly). When it lands, Forge completes the original Lane it was made for (only at the recorded head: a Lane saved with new work after the conflict stays open, while a re-save of the same bytes still completes it; reopen undoes it), so its Intent and Issue close without a manual `complete`. A resolution landing that names no `message` keeps the message (and trailers) of the landing that conflicted, so the GitHub mirror commit still carries it, including when the conflict came from a later recomposed Candidate. Syntax conflicts (both sides parse, the line merge does not) list `reasons`, and the resolve instruction names them. A resolution merges your Lane into main, so each hunk holds main's lines first (main plus any Lanes composed ahead of yours), under `<<<<<<< main`, and your Lane's lines after `=======`, closed by `>>>>>>> lane` (a sync is the other way round: `<<<<<<< lane` above, the sync target below, `>>>>>>> target` on hosted Lanes); a binary or file/directory conflict file holds main's version. Between the two sides each hunk also holds the common base lines under `||||||| base` (diff3 style, as Git's `merge.conflictStyle=diff3`). When your Lane removed or rewrote a whole region and the other side changed only lines inside it, your side's marker label says so and suggests keeping your side (`lane removed this region; main changed only base line(s) N inside it. Suggested resolution: keep the lane side …`); it is a suggestion, never applied for you. Files of any size merge line by line: past the exact diff's size limit the merge aligns on lines that occur once on each side, so a main edit elsewhere in a large file merges and a conflict is never drafted as the whole file only because the file is large.
Text, line endings and one-sided conflict files. Merge, conflict markers, the marker check and the review `diff` treat a file as text the way Git does: no NUL byte in its first 8,000 bytes and no UTF-16 byte-order mark. UTF-8 validity does not matter, so Windows-1252, Latin-1, Shift-JIS and other ASCII-compatible files merge line by line on their exact bytes (lines split at the LF byte), and a disjoint edit merges as it would in UTF-8. `diff` shows their hunks with `encoding:"not-utf-8"`; a line that is not valid UTF-8 has `escaped:true`, each such byte as `\xNN` and a backslash as `\\`, so the text maps back to the exact bytes. Marker lines are ASCII (the labels in UTF-8) and take the line ending of their hunk: CRLF when every terminated line of both sides ends in CRLF, LF when the sides mix endings, and the file's own rule (else LF) when no side line is terminated; a terminated copy of a last line without an ending takes the same ending. A conflict file placed without markers (a binary conflict, or one side kept whole) holds one side unchanged: `resolve` refuses it while it is unchanged, with `CONFLICT_SIDE_REQUIRED`, the paths and two choices with fresh operation ids: edit the file (or write the other side's exact bytes, for example from `show`) and resolve, or keep the version it holds with `resolve {"laneId":"…","keep":["PATH"]}`. Neither choice is taken for you. Working-tree line endings follow the checkout's `.gitattributes` as Git's do with default settings (Issue 44ef42b9): a file Git would check out with CRLF (`eol=crlf`, or `text`/`text=auto` on Windows) has CRLF in your checkout and in the Candidate check, while the stored blob, `show`, the review `diff` and the GitHub mirror keep Git's LF bytes; a save stores such a file as `git add` would, so a CRLF checkout of an LF file is never a change. `ident`, `working-tree-encoding` and filter drivers other than Git LFS are not applied.
Replaying the original `land --save` or `finish` after a conflict follows the resolution's real state: unresolved, the same `resolve`; resolved, that resolution Lane's exact `finish` (one landing, never two); landed, `RESOLVED in Lane ID` and no step; abandoned, one `sync` with a fresh `operationId`. A `landing` or `status` read of a terminal conflict names the same `sync` recovery as `wait` (one landing-status read), never a wait on the ended operation. When source preparation outlives the land budget, land names `wait` (as for every landing); `wait` replays that unsubmitted finish by its id within its budget and then waits on the submission.

Once a folder has become a resolution Lane, a new `land --save` without a Lane
or operation ID uses the Lane currently recorded in that checkout, even after
successive in-place resolutions. Supply the original `operationId` and request
to replay an earlier landing with its retained pins.

After a landing wait, its authoritative observation replaces pending-source
advice. Terminal responses drop obsolete status, progress and replay advice using
only that response: no finish replay or source/server read follows the wait.
A wait deadline retains the exact original-operation continuation.

Transient source I/O retains the operation and bounded work for the existing
finish wake or direct caller continuation. Terminal invalidity or exhaustion
retains its receipt and uses the new-attempt retry above. Successful progress
resets only the next quantum's failure count. See [source-worker recovery and
bounds](../../../operations/hosted-source-worker.md), including
`SOURCE_RETRY_EXHAUSTED`, backoff and the retained compose deadline.
