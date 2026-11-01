// B1.5d agent transcripts: Claude Code keeps each headless session as
// ~/.claude/projects/<mangled cwd>/<sessionId>.jsonl; Codex writes a rollout under its
// per-task CODEX_HOME (agent.mjs copies it). Either lands in the cell directory as
// <prefix>.transcript.jsonl right after the agent exits (the workspace is deleted later),
// and the scans read actions (tool inputs) and what the agent saw (tool results) from it.
import { existsSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function findTranscript(sessionId, projects = join(homedir(), '.claude', 'projects')) {
  if (!sessionId || !existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Copy the session transcript next to the agent's other files; returns the copy or null. */
export function keepTranscript(sessionId, prefix) {
  const found = findTranscript(sessionId);
  if (!found) return null;
  copyFileSync(found, prefix + '.transcript.jsonl');
  return prefix + '.transcript.jsonl';
}

const text = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(c => (typeof c === 'string' ? c : (c.text ?? text(c.content) ?? ''))).join('\n')
      : '';

/** A Codex tool output: a string or input_text parts; a code-mode `exec` result wraps each
 * command's JSON ({"output": "..."}), unwrapped so scans read the text the agent read. */
function codexOutput(output) {
  const parts =
    typeof output === 'string' ? [output] : Array.isArray(output) ? output.map(p => p?.text ?? '') : [];
  return parts
    .map(part => {
      try {
        const inner = JSON.parse(part);
        return typeof inner?.output === 'string' ? `${part}\n${inner.output}` : part;
      } catch {
        return part;
      }
    })
    .join('\n');
}

/** Actions and outputs of a Codex rollout (response items: tool calls and their outputs). */
function codexEntries(entries, actions, seen) {
  for (const { type, payload: p } of entries) {
    if (type !== 'response_item' || !p) continue;
    if (p.type === 'custom_tool_call') actions.push({ tool: p.name, input: String(p.input ?? '') });
    else if (p.type === 'function_call') actions.push({ tool: p.name, input: String(p.arguments ?? '') });
    else if (p.type === 'local_shell_call')
      actions.push({ tool: 'shell', input: JSON.stringify(p.action ?? {}) });
    else if (/_call_output$/.test(p.type)) seen.push(codexOutput(p.output));
  }
}

/** { actions: [{tool, input}], seen: [string] } from a transcript, or from a scripted
 * agent's own stdout/stderr (dry runs have no transcript: its output stands in as `seen`). */
export function readSession(prefix) {
  const actions = [],
    seen = [];
  const file = prefix + '.transcript.jsonl';
  if (existsSync(file)) {
    const entries = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    if (entries.some(e => e.type === 'session_meta')) {
      codexEntries(entries, actions, seen);
      return { source: 'transcript', format: 'codex', actions, seen };
    }
    for (const entry of entries) {
      for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (part.type === 'tool_use')
          actions.push({ tool: part.name, input: JSON.stringify(part.input ?? {}) });
        if (part.type === 'tool_result') seen.push(text(part.content));
      }
    }
    return { source: 'transcript', actions, seen };
  }
  for (const ext of ['.stdout.json', '.stderr.txt'])
    if (existsSync(prefix + ext)) seen.push(readFileSync(prefix + ext, 'utf8'));
  return { source: existsSync(prefix + '.stdout.json') ? 'agent-output' : 'none', actions, seen };
}
