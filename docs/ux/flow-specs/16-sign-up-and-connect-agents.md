# Flow Spec 16: Sign up and connect my agents

**Goal:** A developer wants an account and their agent apps (Claude Code, Codex, Cursor, OpenCode, Pi or another) connected to Forge, with as few steps as possible and no surprises on their machine.
**Covers:** R16, R19, R27

---

## Entry Points

- **From the landing page:** Sign in to start.
- **From their agent:** the agent ran `nforge login` and printed a device approval address and code.

---

## The Flow

### Step 1: Sign in

**What they want:** An account in one step.

**What they see:** One handle field that offers a passkey, with Continue with GitHub below it.

**What they do:** Create a passkey, or continue with GitHub.

**What happens:** The account exists; they land on Home with the first three setup steps as Needs you decisions: connect an agent, connect checks, land the first change.

### Step 2: Install the CLI

**What they want:** The tool their agent uses.

**What they see:** The connect step: one install command, and that the first `nforge` command installs advisory hooks in Claude Code and Codex, listing the files it edits and the undo command.

**What they do:** Copy the install command into a terminal, or paste the setup prompt into their agent.

**What happens:** The CLI is installed; the first command prints the hook files it changed and the undo.

### Step 3: Approve this device

**What they want:** To let this machine act for them, once.

**What they see:** In the terminal, an address and a short approval code. In the browser, the device approval page: the code to match, the kind of machine, a suggested device name (never the host name), and the reach: this project only (default) or all their projects.

**What they do:** Check the code, keep or edit the name, choose the reach, and approve.

**What happens:** The device is recorded with its name and settings; its sign-in renews under the device key while in use. The terminal says it is signed in.

### Step 4: Connect an agent app

**What they want:** Their agent app to use Forge.

**What they see:** Connect your agent: the five first-class apps listed equally, each with one command (`nforge connect APP`), and Another app with the generic MCP or command-line steps folded below.

**What they do:** Run the command for their app.

**What happens:** The command prints exactly what it will change (the app's MCP or plugin configuration, and the hook entries it keeps or installs), keeps a backup, applies the change, and prints the undo command. It never touches unrelated settings.

### Step 5: See it connected

**What they want:** To know it worked.

**What they see:** On load or refresh, the app marked connected once its first authenticated call arrives, with when.

**What they do:** Nothing, or connect another app.

**What happens:** The setup decision for agents leaves Needs you.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The approval code does not match | The page says not to approve and how to start the terminal sign-in again. |
| The approval code expired | The page says it expired; the terminal prints a new code on the next attempt. |
| The passkey prompt closed | Nothing changed; they can try again or continue with GitHub. |
| `nforge connect` finds an existing Forge entry | The preview shows it unchanged, or what it updates, before applying. |
| The app's config file is invalid | The command changes nothing and names the file and the problem. |
| Not connected yet after setup | The app stays unconnected with the command shown; nothing polls. |
| A device idle past 30 days | It comes back with one press in the browser, settings kept. |
| Loading the connect step | The app list keeps its space; commands show once the account's state has loaded. |
| First-time account with no projects yet | Home shows the setup decisions and New project. |

---

## New User vs. Returning User

- **New user:** the three setup decisions lead Needs you on Home and in the first project.
- **Returning user on a new machine:** only the device approval and the connect command; their apps and settings are unchanged.

---

## UX Notes

- Nothing edits a machine silently: every write is listed first and comes with an undo.
- The device name is display only; reach comes from the approval, not the name.
- The default service address and published package wait for Phase 8.

---

## Prototype Scope

- Sign in with the handle field, passkey and GitHub.
- Home for a new account with the three setup decisions.
- The device approval page with code, name and reach.
- Connect your agent with five apps and Another app.
- The `nforge connect` preview, apply and undo output in a terminal.
- The connected state after refresh.
- The code-mismatch and expired states.
