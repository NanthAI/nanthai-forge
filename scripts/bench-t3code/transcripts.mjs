// SPDX-License-Identifier: Apache-2.0
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

/** The text a Codex tool output shows the agent, without the harness wrappers: the `output`
 * of a code-mode result (JSON, possibly nested in a Promise.allSettled list) or the plain
 * text. Used to judge what a command returned. */
function codexResult(output) {
  const parts =
    typeof output === 'string' ? [output] : Array.isArray(output) ? output.map(p => p?.text ?? '') : [];
  const out = [];
  const META = new Set(['chunk_id', 'wall_time_seconds', 'original_token_count', 'status', 'exit_code']);
  (function collect(v) {
    if (typeof v === 'string') {
      try {
        const j = JSON.parse(v);
        if (j && typeof j === 'object') return collect(j);
      } catch {}
      out.push(v);
    } else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      if (typeof v.output === 'string') collect(v.output);
      else for (const [k, x] of Object.entries(v)) if (!META.has(k)) collect(x);
    }
  })(parts.filter(p => !/^(Script (completed|running)|Wall time|Output:)/.test(p.trim())));
  return out.join('\n');
}

/** Actions and outputs of a Codex rollout (response items: tool calls and their outputs).
 * Each action carries its call id and `result`, what its call returned; a code-mode cell that
 * keeps running ("Script running with cell ID n") collects the outputs of the `wait` calls
 * that resume it. */
function codexEntries(entries, actions, seen) {
  const byCall = new Map();
  const cells = new Map(); // running cell id -> the action that started it
  const waits = new Map(); // wait call id -> cell id
  const add = (tool, input, p) => {
    const action = { tool, input, id: p.call_id, result: '' };
    actions.push(action);
    if (p.call_id) byCall.set(p.call_id, action);
    return action;
  };
  for (const { type, payload: p } of entries) {
    if (type !== 'response_item' || !p) continue;
    if (p.type === 'custom_tool_call') add(p.name, String(p.input ?? ''), p);
    else if (p.type === 'function_call') {
      add(p.name, String(p.arguments ?? ''), p);
      if (p.name === 'wait') {
        try {
          waits.set(p.call_id, String(JSON.parse(p.arguments).cell_id));
        } catch {}
      }
    } else if (p.type === 'local_shell_call') add('shell', JSON.stringify(p.action ?? {}), p);
    else if (/_call_output$/.test(p.type)) {
      seen.push(codexOutput(p.output));
      const shown = codexResult(p.output);
      const action = byCall.get(p.call_id);
      if (action) action.result += `${action.result ? '\n' : ''}${shown}`;
      const running = /Script running with cell ID (\d+)/.exec(JSON.stringify(p.output ?? ''));
      if (action && running) cells.set(running[1], action);
      const owner = cells.get(waits.get(p.call_id));
      if (owner && owner !== action) owner.result += `\n${shown}`;
    }
  }
}

/** { actions: [{tool, input, id, result}], seen: [string] } from a transcript, or from a scripted
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
    const byId = new Map();
    for (const entry of entries) {
      for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (part.type === 'tool_use') {
          const action = {
            tool: part.name,
            input: JSON.stringify(part.input ?? {}),
            id: part.id,
            result: '',
          };
          actions.push(action);
          if (part.id) byId.set(part.id, action);
        }
        if (part.type === 'tool_result') {
          const shown = text(part.content);
          seen.push(shown);
          const action = byId.get(part.tool_use_id);
          if (action) action.result += `${action.result ? '\n' : ''}${shown}`;
        }
      }
    }
    return { source: 'transcript', actions, seen };
  }
  for (const ext of ['.stdout.json', '.stderr.txt'])
    if (existsSync(prefix + ext)) seen.push(readFileSync(prefix + ext, 'utf8'));
  return { source: existsSync(prefix + '.stdout.json') ? 'agent-output' : 'none', actions, seen };
}
