### Agent runs and client detection

A run is selected locally, once per CLI process, without a server call or idle work.
`FORGE_HUMAN=1` forces a person. Otherwise a nonempty `FORGE_AGENT_SESSION` wins over
all ambient client variables and an MCP transport's session. Its value is an opaque
session declaration, not a display name; only its word-list digest is sent to Forge.
Use a different value per agent and preserve it when that agent resumes:

```sh
export FORGE_AGENT_SESSION="$(uuidgen)"
```

An orchestrator generates that value once per child and passes it through the child's
commands and relays. It must not copy one parent declaration into every child.

Without an explicit declaration, Forge walks local parent processes, comparing only
executable basenames against `AGENT_CLIENTS` in `src/agent-session.ts`. The closest
recognised agent wins, including through shell/Node relay intermediaries. Its own
session variable is used when available; inherited variables belonging to outer agents
are ignored. If its own variable is absent, a domain-separated hash of that ancestor's
PID and kernel start time identifies its process session. The PID, executable, start
time, machine paths and account identity are never sent. PID reuse has a different run.
Native session IDs survive client restarts; a process fallback lasts for that process's
lifetime. An explicit declaration also survives a relay that detaches from the client.

The agent-session tests run once more under a simulated Claude Code parent and once under a
simulated Codex parent (`tests/agent-parent-simulated.test.mjs`, in the full run and in the
`agent parent simulation` preflight guard), so a test that only passes without an agent parent fails
in CI, not on a builder's machine (Item b574ed11). A new test that reads the agent parent or session
variables joins that run, or is listed there with the reason it is left out.

The table is data-driven: adding an executable/session convention is one row in
`AGENT_CLIENTS`. Names are matched case-insensitively, with `.exe` removed; `*` is a
basename wildcard. The table below cites the primary interface used, rather than
assuming a configuration directory or a boolean agent marker is a session ID.
“Not documented” means no shell session variable was established in the cited interface,
not that no version or extension can provide one. When a hook-only variable is missing
from an ordinary tool shell, the process fallback applies.

| Harness | Executable basenames | Session signal used | Verification / primary source |
| --- | --- | --- | --- |
| Claude Code | `claude`, `claude-code` | `CLAUDE_CODE_SESSION_ID` | Live sibling Bash commands, including inherited Codex identity; [environment reference](https://code.claude.com/docs/en/env-vars), [CLI](https://code.claude.com/docs/en/cli-reference). |
| Codex | `codex`, `codex-*` | `CODEX_THREAD_ID` | Live sibling commands, including inherited Claude identity; [subprocess environment source](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/core/src/exec_env.rs). |
| Pi | `pi`, `pi-rpc`, `pi-coding-agent` | `PI_SESSION_ID` in LLM shell tools; process key otherwise | Live sibling RPC Bash processes, including the no-variable fallback; native tool-variable fixture. [Environment](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/environment-variables.md), [CLI setup](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/cli/setup.ts). |
| T3 Code | `t3`, `t3 code` | `T3CODE_THREAD_ID` when T3 is the nearest agent; native children use their closer row | Live relay lineage to sibling Codex and Claude commands; T3-only fixture. [Thread declaration](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/preview/PortScanner.ts), [Codex per-thread injection](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts), [Claude injection](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts). |
| OpenCode | `opencode` | `OPENCODE_SESSION_ID` where exported; process key otherwise | Live sibling server shell processes with no native variable; native-variable fixture. [Shell environment source](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/shell.ts), [commands](https://opencode.ai/docs/cli/commands). |
| Cursor CLI | `cursor-agent` | No shell session ID established; process key | Fixture, not live. `CURSOR_AGENT` is a marker, not a session. [CLI](https://docs.cursor.com/en/cli/overview), [terminal marker](https://docs.cursor.com/en/agent/terminal). |
| Gemini CLI | `gemini` | `GEMINI_SESSION_ID` in hooks; process key when absent | Fixture, not live. [Hook environment](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md), [CLI commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md). |
| GitHub Copilot CLI | `copilot` | No shell session ID established; process key | Fixture, not live. A `--session-id` option is not an exported environment variable. [CLI and environment reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference). |
| Amp | `amp` | No shell thread ID established; process key | Fixture, not live. [CLI configuration](https://ampcode.com/docs/cli/settings), [thread interface](https://ampcode.com/docs/threads). |
| Aider | `aider` | No shell session ID established; process key | Fixture, not live. [Usage](https://aider.chat/docs/usage.html), [configuration variables](https://aider.chat/docs/config.html). |
| Goose | `goose` | No shell session ID established; process key | Fixture, not live. [CLI task interface](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/running-tasks.md). |
| Factory Droid | `droid` | No shell session ID established; process key | Fixture, not live. JSON output's `session_id` is not assumed to be an environment variable. [Headless CLI](https://docs.factory.com/droid-exec/overview). |
| Crush | `crush` | `CRUSH_SESSION_ID` in hooks; process key when absent | Fixture, not live. [Hook environment](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md). |
| Qwen Code | `qwen` | `QWEN_CODE_SESSION_ID` | Fixture, not live. [Session environment source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/config.ts), [commands](https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/). |
| Cline | `cline` for the CLI; generic VS Code host for extension terminals | CLI process key; `FORGE_AGENT_SESSION` per extension agent | Fixture, not live. [CLI](https://github.com/cline/cline/blob/main/apps/cli/README.md), [extension terminal source](https://github.com/cline/cline/blob/main/apps/vscode/src/hosts/vscode/terminal/VscodeTerminalManager.ts). |
| Roo Code | `roo` for the CLI; generic VS Code host for extension terminals | CLI process key; `FORGE_AGENT_SESSION` per extension agent | Fixture, not live. [CLI](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/cli/README.md), [terminal registry](https://github.com/RooCodeInc/Roo-Code/blob/main/src/integrations/terminal/TerminalRegistry.ts). |
| Kilo Code | `kilo` for the CLI; generic VS Code host for extension terminals | CLI process key; `FORGE_AGENT_SESSION` per extension agent | Fixture, not live. [Session terminal source](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-vscode/src/agent-manager/SessionTerminalManager.ts), [shell integration](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/automate/extending/shell-integration.md). |
| Zed / ACP agents | The external agent's executable row above | The external agent's native variable/process key, or `FORGE_AGENT_SESSION` per editor-hosted agent | Fixture, not live. [External agent process model](https://zed.dev/docs/ai/external-agents), [terminal interface](https://zed.dev/docs/terminal). |
| MCP | Client/transport supplied session, not a guessed environment name | Explicit transport session; `FORGE_AGENT_SESSION` still wins | Hosted MCP fixture. [Transport session protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). |
| Other recognisable agents | `agent`, `*-coding-agent` | Opaque process key | Fixture, not live; explicit per-agent declaration works for any executable. |

Cline, Roo and Kilo extension terminals and Zed's editor-hosted agents were checked,
but no generic `Code`, `Code Helper`, `zed`, shell, or Node executable row is added:
those processes also serve people and can share several agent conversations. The cited
extension terminal APIs do not establish an exported per-conversation ID. Executable
ancestry alone cannot distinguish two sessions sharing that same host. Set the explicit
declaration above once in each agent's persistent terminal or launch environment; the
shared-host fixture verifies distinct, stable runs with those declarations. ACP agents
that own a separate recognised process use that process automatically. Forge does not
claim that a shared IDE process proves a unique agent or turn a person's editor terminal
into an agent. The same observability limit applies to a shared server that exports no
per-request session identifier: separate server processes have separate process runs;
multiple logical sessions inside one such process need an explicit declaration.

A plain shell with no agent ancestor or session declaration remains a person. If local
ancestry is unavailable, one known session declaration remains usable; multiple
unattributable declarations are combined into an opaque digest instead of selecting a
parent with a fixed precedence. That fallback is stable for the same declarations. An
explicit session provides continuity if those ambient declarations change. Run selection
is reused by receipts, presence, idle ownership, replay scope and turn-work ledgers; it
adds no Convex calls, DB I/O, subscriptions or polling. An MCP transport can still supply
its own session without a shell environment declaration.
