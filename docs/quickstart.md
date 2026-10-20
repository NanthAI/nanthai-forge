# Offline Git adoption

Forge is a source host and workspace for humans and AI agents working on the same
code. This flow uses local files and commands, with no account or network service.
Install Forge and Node 22.12+ or 24 first. Read this document from any directory
with `nforge docs quickstart`; `nforge docs` lists the packaged documentation.

## Import a committed snapshot

Choose an existing Git repository and a new, nonexistent destination. Import reads
committed source and retains original Git history; working edits remain in Git.
It does not run repository hooks or package scripts.

```sh
GIT_ROOT=/absolute/path/to/git-project
OWNER=/absolute/path/to/new-forge-project
COMMIT=$(git -C "$GIT_ROOT" rev-parse HEAD)
nforge import-native-git "$GIT_ROOT" "$COMMIT" "$OWNER"
```

Pass the full commit ID, not the literal `HEAD`. If rejected, run
`git rev-parse HEAD` in the Git repository and pass its output.
The import receipt contains the selected commit and native source head. It also
prints `nextCommand` for starting work. The imported snapshot is the bootstrap
source: **there is no main Channel yet**. The first human acceptance below creates
`main`; subsequent Lanes start from accepted main.

## Define a check, start, edit and finish

For a project with a committed `check.mjs` test script, register the local Node
executable. Replace the script argument with your project's real check. Checks run
in a fresh exact snapshot directory, so prepare any required dependencies in the
check itself. Checks execute with your OS account's rights.

```sh
NODE=$(node -p 'process.execPath')
nforge agent "$OWNER" define-check "{\"name\":\"verify\",\"executable\":\"$NODE\",\"args\":[\"check.mjs\"],\"environmentLabel\":\"Local Node\"}"
export FORGE_AGENT_NAME=agent-a
nforge agent "$OWNER" start '{"outcome":"Improve the greeting"}'
```

Use the returned `laneId` and `path`. Edit and run your tests inside that Lane
path. Each concurrent shell starts its own Lane and uses its own name, such as
`FORGE_AGENT_NAME=agent-b`. Alternatively pass `"actor":"agent-a"` in start JSON;
that overrides `FORGE_AGENT_NAME`, then `FORGE_ACTOR`. Optional `"tool":"codex"`
records the tool. These names are attribution claims, not authentication.

```sh
nforge agent "$OWNER" finish '{"laneId":"LANE_ID","message":"Improve greeting","accept":true}'
```

Finish checkpoints, syncs accepted main when needed, composes a Candidate and runs the
check. Resolve any reported conflicts in the Lane and finish again. Preserve the
returned operation ID and `resolved` fields when retrying an unknown outcome.

## Supervised review and first main

New imports use the supervised policy. A passed check with `accept:true` returns
`status:"awaiting-review"`, `complete:false`: it is ready for a person and has not
been accepted. The final human-readable line gives this exact next command with
your owner path:

```sh
nforge serve "$OWNER"
```

Keep that foreground server running and open its printed private local session
URL. In Review, open the checked Candidate from the finish receipt, inspect its changes
and check result, and select Accept into main as a person. This first acceptance
establishes main. Future acceptance advances it while retaining accepted work.
If main moved, re-check the Lane on latest main and review its new Candidate.
No policy change is needed for this flow.

## Glossary

| Term | Meaning | UI label? |
| --- | --- | --- |
| Intent | The outcome someone wants; groups related work. | Yes, also a CLI concept. |
| Lane | One contributor's isolated working directory and saved source history. | Yes, also a CLI concept. |
| Candidate (formerly View) | An exact pinned combination of Lane heads for checks and review. | Yes, also a CLI concept. |
| Channel | A named pointer to accepted source, usually main. Like a protected branch: it moves only when a Candidate is accepted. | Yes, also a CLI concept. |
| Check | A configured command; a run records its result against an exact Candidate. | Yes, also a CLI concept. |
| Now | The activity screen showing current work and observed agent presence. | UI navigation label. |
| Needs you | Work or messages needing your attention, such as review or a reply. | UI label, not a separate source state. |

## Native capture coverage

`init-native` returns `captureCoverage`: the included file count, excluded path
count, and up to 100 excluded paths with reasons. Initialization retries return
the original coverage saved with the initial State; older initialization receipts
may lack this field. Lane checkpoint receipts also report capture coverage.
Inspect exclusions when adopting a directory or saving new files.

Native capture includes source modules such as `src/secret-crypto.ts`,
`convex/secrets.ts`, and `web/src/Secrets.tsx`; a secret or credential prefix does
not exclude recognized TypeScript, JavaScript, Python, Java or Rust source files.
Explicit `.gitignore` rules still apply to new files. Credential/config names
such as `.env`, `.env.local`, `.env.production`, and `credentials.json` retain their
exclusions and appear in coverage. Placeholder files named `.env.example`,
`.env.sample`, `.env.template`, or ending in `.env.example`, `.env.sample`, or
`.env.template` are captured unless explicitly ignored. Already retained source
stays captured through ignore rules.
