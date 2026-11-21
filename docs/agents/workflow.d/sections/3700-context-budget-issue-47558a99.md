## Context budget (Issue 47558a99)

What Forge costs an agent's context is measured in characters of what it sends, with tokens approximated
as characters / 4 (a stable proxy for both Claude and Codex tokenizers; compare before and after with the
same one). `node scripts/measure-agent-context.mjs` prints the hosted MCP tool list per tool.

- **Tool list.** The hosted agent MCP lists eight tools in about 5.9k characters (about 1.5k tokens, the
  Issue target; it was 54.6k, then 11.7k). A command tool carries a short description, the `action` enum and
  one description string: required fields per action (`check/run(checkId,candidateId)`, modes as
  `save:sync|candidate`), then every field by name with `:b`/`:n`/`:o`/`:a` for a non-string type and
  `name=a|b` for a short enum. Flat tools list their fields the same way. Strict Zod schemas still
  validate every call, so a wrong field or type is refused with its error. `forge_work_overview
  {action:"help"}` lists tools and actions; `{action:"help",topic:"<action>"}` returns the exact schema of
  that action and the long prose of its tool; `topic:"forge_task"` includes the live project rules (the
  listing is constant, so a policy change never re-sends it). Claude Code and Codex receive the same
  listing (`scripts/measure-agent-context.mjs` prints each harness's view). A change that adds an action
  or field must keep `tests/mcp-tool-list.test.mjs` inside its budget or record why the budget moves.
- **Help topics and errors that teach.** `nforge agent ROOT help` prints the command overview and the
  topic list; `help TOPIC` prints one section of at most 1,500 characters, and `ACTION --help` prints the
  action's schema plus only its own topic (MCP: `forge_work_overview {action:"help",topic}`). Every CLI
  refusal adds `next` (one command to run now, with the caller's root, Lane and run ids where known; a
  CAPITALS placeholder is a value to supply) and `learn` (the help command for its topic) beside the
  unchanged `code`, `message` and `recovery`; a server continuation in `recovery` becomes `next`. MCP
  refusals add `learn` as a help call. A terminal error inside a CLI receipt gains `learn`. `npm run check`
  fails when a public error code has no topic, or a `next` or topic names a command, action or topic that
  does not exist (`scripts/check-error-teaching.mjs`; the table is `src/error-teaching.ts`, the topics
  `src/help-topics.ts`). Help and teaching are local: no Convex call.
- **Receipts.** The CLI prints, and MCP replies carry, a brief receipt of about 300 characters when
  healthy: `action`, `operationId` and the next step's facts. `start`: Lane id and path; `save`: the saved
  head; `sync`: `up-to-date|merged|resolved` and the head; a landed landing: the acceptance receipt, State
  and test counts. Dropped as constant or derivable: `cliCommit`, a `resolved` that
  is only the operation id, timings (`landTiming`, sync steps), Lane versions, a clean
  main-distance report and idle-Lane paths (the stderr hint lists them). A Lane behind main keeps
  its conflicting paths; a conflicted sync keeps file summaries and recovery; a failed landing
  keeps its error and recovery. Replies retain `resolved` replay inputs, failed test files in full and flaky ones by
  name, `retry` (`passed`: it failed an attempt and then passed; a file whose retry failed is under `failed`)
  and the start of their error. A normal queued submit has a 1,200-character budget. Its brief keeps the
  queue position, the structured `next` wait target and one runnable command (`wake.command` for
  background wake, otherwise `waitCommand`). The brief summarizes routine preflight advice by count
  and outcome and keeps commands for incomplete or failed checks. Before admission and when recovery
  is needed, replies keep the original replay parameters and recovery command. Use `--detail`
  (MCP: `replyDetail:true`) when replaying the call with its operation id for the full receipt, including
  the optional preflight plan.
- **Waiting.** While a landing is queued, `land --save`/`wait` print one line per change of phase, queue
  position or outcome (position, ahead, total, wouldConflict advice, recovery, error code), never the whole
  submission or resume cursor again. An IN_PROGRESS result still carries the cursor and one resume command.
  When main lands a file the queued entry also changes, the wait ends at once with `SYNC_REQUIRED`
  (exit 2) and the one recovery, the same Lane's `land --save` (with the Lane and message of the
  original land); run it instead of waiting. Its new head supersedes the old queued entry.
