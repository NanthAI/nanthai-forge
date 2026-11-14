#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Rework tokens per landing (Issue bf130503, P6 exit bar 8c9b84fc): a deterministic phase
// classifier over one agent session. Every model response (turn) gets one phase from the
// source commands it runs and the last source-command results before it:
//   coding   before the first save, push, PR or landing request;
//   landing  from then to acceptance (the turn that sends a landing attempt is landing);
//   rework   after a result that reports a conflict, CHANNEL_CHANGED, CHECK_FAILED, a removal
//            from the merge queue, a failed rebase or a rejected push, until the next landing
//            attempt (Forge land/finish; GitHub git push or gh pr merge);
//   waiting  a landing-phase turn whose only commands are status reads or polls (sleep too);
//   done     after acceptance (LANDED receipt, merged PR).
// Inputs: the session transcript (Claude session jsonl or `claude -p --output-format
// stream-json` output, or a Codex rollout) and, for the Forge arm, the relay's call log
// (nforge-calls.jsonl), joined by order and verb so structured error codes count too.
// Pure text work: no network, no product calls. Usage: node phases.mjs PREFIX [CALL_LOG TASK]
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commandText, shellCommands, commandInvocations } from './command-text.mjs';
import { codexResult } from './transcripts.mjs';

export const PHASES = ['coding', 'landing', 'rework', 'waiting', 'done'];
const USAGE_KEYS = ['input', 'cachedInput', 'cacheWrite', 'output'];
const zero = () => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0 });

export const jsonLines = text =>
  String(text ?? '')
    .split('\n')
    .flatMap(line => {
      if (!line.startsWith('{')) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

const text = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(c => (typeof c === 'string' ? c : (c?.text ?? text(c?.content) ?? ''))).join('\n')
      : '';

/** Claude reports uncached input, cache reads and cache writes apart; one response's content
 * blocks arrive as separate entries that repeat its usage, so fields merge by maximum. */
const claudeUsage = u => ({
  input: u?.input_tokens ?? 0,
  cachedInput: u?.cache_read_input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
});
/** Codex input_tokens include the cached part; output_tokens include reasoning. */
const codexUsage = u => ({
  input: Math.max(0, (u?.input_tokens ?? 0) - (u?.cached_input_tokens ?? 0)),
  cachedInput: u?.cached_input_tokens ?? 0,
  cacheWrite: u?.cache_write_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
});

function claudeTurns(entries) {
  const turns = [],
    byMessage = new Map(),
    byTool = new Map();
  for (const e of entries) {
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === 'assistant' && e.message) {
      const id = e.message.id ?? e.uuid ?? `#${turns.length}`;
      let turn = byMessage.get(id);
      if (!turn) {
        turn = { at: e.timestamp ?? null, usage: zero(), calls: [] };
        byMessage.set(id, turn);
        turns.push(turn);
      }
      const u = claudeUsage(e.message.usage);
      for (const k of USAGE_KEYS) turn.usage[k] = Math.max(turn.usage[k], u[k]);
      for (const part of content)
        if (part.type === 'tool_use') {
          const call = { tool: part.name, input: JSON.stringify(part.input ?? {}), result: '' };
          turn.calls.push(call);
          if (part.id) byTool.set(part.id, call);
        }
    } else if (e.type === 'user')
      for (const part of content)
        if (part.type === 'tool_result') {
          const call = byTool.get(part.tool_use_id);
          if (call) call.result += `${call.result ? '\n' : ''}${text(part.content)}`;
        }
  }
  return turns;
}

/** A Codex response's tool calls precede its token_usage_record. A command that keeps running
 * is resumed by later calls (`wait` on a code-mode cell, `write_stdin` on an exec session):
 * each resuming call shows the output that arrived then and points at the call it resumes
 * (`owner`), so a result counts in the turn that saw it. */
function codexTurns(entries) {
  const turns = [],
    byCall = new Map(),
    cells = new Map(),
    sessions = new Map();
  let pending = [];
  const ownerOf = call => {
    const cell = call.tool === 'wait' ? /"cell_id"\s*:\s*"?(\d+)/.exec(call.input)?.[1] : null;
    const session = /write_stdin\(\s*\{\s*session_id\s*:\s*(\d+)/.exec(call.input)?.[1];
    return (cell && cells.get(cell)) || (session && sessions.get(session)) || null;
  };
  for (const { type, payload: p, timestamp } of entries) {
    if (!p) continue;
    if (type === 'token_usage_record') {
      turns.push({ at: timestamp ?? null, usage: codexUsage(p.usage), calls: pending });
      pending = [];
      continue;
    }
    if (type !== 'response_item') continue;
    if (['custom_tool_call', 'function_call', 'local_shell_call'].includes(p.type)) {
      const input =
        p.type === 'local_shell_call' ? JSON.stringify(p.action ?? {}) : String(p.input ?? p.arguments ?? '');
      const call = { tool: p.name ?? 'shell', input, result: '', invocations: commandInvocations(input) };
      const owner = ownerOf(call);
      if (owner) call.owner = owner;
      pending.push(call);
      if (p.call_id) byCall.set(p.call_id, call);
    } else if (/_call_output$/.test(p.type)) {
      const call = byCall.get(p.call_id);
      if (!call) continue;
      const parts = typeof p.output === 'string' ? [p.output] : (p.output ?? []).map(x => x.text ?? '');
      const bodies = parts.filter(x => !/^(Script (completed|running)|Wall time|Output:)/.test(x.trim()));
      const invocations = call.invocations?.length ? call.invocations : call.owner?.invocations;
      if (invocations?.length > 1 && bodies.length === invocations.length) {
        call.children = invocations.map((inv, index) => {
          const child = {
            tool: 'exec_command',
            input: inv.command,
            result: codexResult(bodies[index], { structured: true }),
          };
          const owner = ownerOf({
            tool: inv.tool,
            input: inv.tool === 'write_stdin' ? `write_stdin(${inv.input})` : inv.input,
          });
          if (owner) child.owner = owner;
          const raw = bodies[index];
          for (const m of raw.matchAll(/session_id[\\"]*:(\d+)/g)) sessions.set(m[1], child.owner ?? child);
          const cell = /Script running with cell ID (\d+)/.exec(raw)?.[1];
          if (cell) cells.set(cell, child.owner ?? child);
          return child;
        });
      }
      call.result += `${call.result ? '\n' : ''}${codexResult(p.output, { structured: true })}`;
      const raw = JSON.stringify(p.output ?? '');
      const cell = /Script running with cell ID (\d+)/.exec(raw)?.[1];
      if (cell) cells.set(cell, call);
      for (const m of raw.matchAll(/session_id[\\"]*:(\d+)/g))
        if (!sessions.has(m[1])) sessions.set(m[1], call.owner ?? call);
    }
  }
  if (pending.length) turns.push({ at: null, usage: zero(), calls: pending, usageMissing: true });
  for (const turn of turns) turn.calls = turn.calls.flatMap(call => call.children ?? [call]);
  return turns;
}

/** Turns of one session: [{ at, usage: {input, cachedInput, cacheWrite, output}, calls }]. */
export function sessionTurns(entries) {
  return entries.some(e => e.type === 'session_meta') ? codexTurns(entries) : claudeTurns(entries);
}

const NEUTRAL = new Set(
  'cd echo printf tail head jq grep rg cat true wc sed awk sort uniq tee date pwd ls'.split(' '),
);
const FORGE_POLLS = new Set(['status', 'wait', 'observe', 'queue']);
const gitSub = w => {
  for (let i = 1; i < w.length; i++) {
    if (w[i] === '-C' || w[i] === '-c') i++;
    else if (!w[i].startsWith('-')) return w[i];
  }
  return null;
};
const ghPoll = w => {
  const [, a, b] = w;
  if (a === 'pr') return ['view', 'checks', 'status'].includes(b);
  if (a === 'run') return ['view', 'list', 'watch'].includes(b);
  if (a !== 'api') return false;
  if (b === 'graphql') return !w.some(x => /\bmutation\b/.test(x));
  return !w.some(x => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(x));
};

/** What one tool call does to the source: its forge verbs, publish/attempt, polls, re-syncs. */
export function callKinds(call) {
  const k = {
    source: false,
    publish: false,
    attempt: false,
    polls: 0,
    other: 0,
    resyncs: 0,
    forge: [],
    commands: [],
  };
  // Resuming a running command (Codex `wait`, `write_stdin`) is a poll; so is Codex `sleep`.
  if (call.owner || call.tool === 'sleep') k.polls++;
  if (call.tool === 'sleep' || call.tool === 'wait') return k;
  if (!/^(Bash|exec|exec_command|shell|local_shell)$/i.test(String(call.tool))) return { ...k, other: 1 };
  for (const { words } of shellCommands(commandText(call.input, call.tool))) {
    const w = words.map(String);
    if (!w.length) continue;
    const name = w[0].split('/').at(-1);
    let help = w.includes('--help') || w.includes('-h');
    if (name === 'nforge') {
      const verb = ['agent', 'x'].includes(w[1]) ? w[3] : w[1];
      // Docs pages quote error codes and conflict markers; reading them is help, not a result.
      if (['docs', 'help'].includes(verb)) help = true;
      k.source = true;
      k.forge.push({ verb, help });
      k.commands.push({ help });
      if (help) k.other++;
      else if (FORGE_POLLS.has(verb)) k.polls++;
      else {
        k.other++;
        if (['save', 'checkpoint', 'land', 'finish'].includes(verb)) k.publish = true;
        if (['land', 'finish'].includes(verb)) k.attempt = true;
        if (verb === 'sync') k.resyncs++;
      }
    } else if (name === 'git' || name === 'gh') {
      k.source = true;
      help ||= (name === 'git' ? gitSub(w) : w[1]) === 'help';
      k.commands.push({ help });
      if (help) k.other++;
      else if (name === 'gh' && ghPoll(w)) k.polls++;
      else {
        k.other++;
        const sub = name === 'git' ? gitSub(w) : `${w[1]} ${w[2]}`;
        if (['push', 'pr create', 'pr merge'].includes(sub)) k.publish = true;
        if (['push', 'pr merge'].includes(sub)) k.attempt = true;
        if (['pull', 'merge', 'rebase'].includes(sub)) k.resyncs++;
      }
    } else if (name === 'sleep') k.polls++;
    else if (!NEUTRAL.has(name)) k.other++;
  }
  return k;
}

// Result patterns of both arms; the Forge codes never appear in Git output and vice versa.
export const TRIGGERS = [
  [
    'conflict',
    /\b(COMPOSITION_CONFLICT|WORK_CONFLICT|HOSTED_CONFLICT)\b|<<<<<<< lane|^CONFLICT \([^)\r\n]+\): .+|Automatic merge failed|"mergeStateStatus"\s*:\s*"DIRTY"/,
  ],
  ['channel-changed', /\bCHANNEL_CHANGED\b/],
  ['check-failed', /\bCHECK_FAILED\b|"phase"\s*:\s*"terminal-failed"|"conclusion"\s*:\s*"FAILURE"|\tfail\t/i],
  ['queue-removed', /RemovedFromMergeQueueEvent|removed from the merge queue/i],
  ['rebase-failed', /could not apply [0-9a-f]{7,}|Resolve all conflicts manually/],
  ['push-rejected', /! \[rejected\]|Updates were rejected|failed to push some refs/],
];
const CANCELLED = /\bLANDING_CANCELLED\b/;
// Historical evidence (a timeline event, a failed run's line) is shown again on every later
// read; it counts once. Conflicts are current state and count each time they are reported.
const ONCE = new Set(['queue-removed', 'check-failed']);
const LANDED =
  /^LANDED\b|"phase"\s*:\s*"landed"|"state"\s*:\s*"MERGED"|^(state:\s+)?MERGED\s*$|"mergedAt"\s*:\s*"\d{4}|Merged pull request/m;
const CODE_TRIGGERS = {
  COMPOSITION_CONFLICT: 'conflict',
  WORK_CONFLICT: 'conflict',
  HOSTED_CONFLICT: 'conflict',
  CHANNEL_CHANGED: 'channel-changed',
  CHECK_FAILED: 'check-failed',
};

/** Remove only speculative predecessor advice, retaining sibling real failures. */
function resultLines(result) {
  return result.split('\n').flatMap(line => {
    try {
      const value = JSON.parse(line);
      const clean = v => {
        if (Array.isArray(v)) return v.map(clean);
        if (!v || typeof v !== 'object') return v;
        return Object.fromEntries(
          Object.entries(v)
            .filter(([k, x]) => !(k === 'wouldConflict' && x?.predecessor))
            .map(([k, x]) => [k, clean(x)]),
        );
      };
      return [JSON.stringify(clean(value))];
    } catch {
      return /^Advisory COMPOSITION_CONFLICT .*No agent action is needed\./.test(line.trim()) ? [] : [line];
    }
  });
}

/** Join the Forge relay's rows (one task) to the session's nforge commands by order and verb. */
function joinCalls(turns, rows) {
  const ordered = [...rows].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  let next = 0,
    commands = 0,
    matched = 0;
  for (const turn of turns)
    for (const call of turn.calls)
      for (const { verb, help } of call.kinds.forge) {
        commands++;
        const at = ordered.findIndex(
          (r, i) =>
            i >= next &&
            r.args?.[0] === verb &&
            (r.args.includes('--help') || r.args.includes('-h') || ['docs', 'help'].includes(r.args[0])) ===
              help,
        );
        if (at < 0) continue;
        matched++;
        next = at + 1;
        (call.rows ??= []).push(ordered[at]);
      }
  return { commands, matched, rows: rows.length };
}

function sourceCall(call) {
  for (let current = call; current; current = current.owner) if (current.kinds?.source) return current;
  return null;
}

/** Phase per turn and totals per phase. `rows`: the task's relay rows (Forge arm) or null. */
export function classify(turns, { rows = null } = {}) {
  for (const turn of turns)
    for (const call of turn.calls) {
      call.kinds = callKinds(call);
      if (call.owner && !call.owner.kinds) call.owner.kinds = callKinds(call.owner);
    }
  const joined = rows ? joinCalls(turns, rows) : null;
  // A relay row records how its command ended. A command that keeps running (a Codex exec
  // session resumed by write_stdin/wait) shows that end only on a later read, so its codes count
  // in the last turn that reads the command, not the turn that started it (polls in between are
  // waiting, not rework).
  const lastRead = new Map();
  turns.forEach((turn, i) => {
    for (const call of turn.calls)
      for (let current = call; current; current = current.owner) lastRead.set(current, i);
  });
  const recovery = { active: { turns: 0, ...zero() }, waiting: { turns: 0, ...zero() } };
  const totals = Object.fromEntries(PHASES.map(p => [p, { turns: 0, ...zero() }]));
  const events = { publishes: 0, attempts: 0, reworkEpisodes: 0, resyncs: 0, triggers: [] };
  const seen = new Set();
  let state = 'coding',
    landedAtTurn = null;
  const phases = turns.map((turn, i) => {
    const calls = turn.calls;
    const publish = calls.some(c => c.kinds.publish),
      attempt = calls.some(c => c.kinds.attempt);
    let phase = state;
    if (state === 'coding' && publish) phase = state = 'landing';
    else if (state === 'rework' && attempt) phase = state = 'landing';
    else if (
      state === 'landing' &&
      calls.length &&
      calls.every(c => c.kinds.other === 0) &&
      calls.some(c => c.kinds.polls > 0)
    )
      phase = 'waiting';
    events.publishes += publish ? 1 : 0;
    events.attempts += attempt ? 1 : 0;
    for (const c of calls) events.resyncs += c.kinds.resyncs;
    const t = totals[phase];
    t.turns++;
    for (const k of USAGE_KEYS) t[k] += turn.usage[k];
    if (phase === 'rework') {
      const target =
        calls.length && calls.every(c => c.kinds.other === 0) && calls.some(c => c.kinds.polls > 0)
          ? recovery.waiting
          : recovery.active;
      target.turns++;
      for (const k of USAGE_KEYS) target[k] += turn.usage[k];
    }
    // What this turn's commands returned decides the next turn's phase.
    if (state !== 'coding' && state !== 'done') {
      const found = [],
        counted = new Set();
      for (const c of calls) {
        const from = sourceCall(c);
        if (!from) continue;
        const help = from.kinds.commands.some(f => f.help);
        const mixed = help && from.kinds.commands.some(f => !f.help);
        if (help && !mixed) continue;
        for (const [kind, re] of TRIGGERS)
          for (const line of resultLines(c.result)) {
            // Shell output without child boundaries can quote help. Retain executed CLI
            // envelopes, actual FAILED/Git replies and relay outcomes, not quoted prose.
            if (mixed && !/^\s*\{|^FAILED\b|^CONFLICT \(|^! \[rejected\]/.test(line)) continue;
            if (!re.test(line)) continue;
            // A cancelled or conflicted landing ends terminal-failed too; it is not a failed check.
            if (kind === 'check-failed' && (CANCELLED.test(line) || TRIGGERS[0][1].test(line))) continue;
            const key = `${kind}\u0000${line.trim()}`;
            if (ONCE.has(kind) && seen.has(key)) continue;
            seen.add(key);
            found.push(kind);
          }
        const ended = from;
        if (lastRead.get(ended) !== i || counted.has(ended)) continue;
        counted.add(ended);
        for (const r of ended.rows ?? []) {
          if (['help', 'docs'].includes(r.args?.[0]) || r.args?.includes('--help') || r.args?.includes('-h'))
            continue;
          for (const code of r.errorCodes ?? []) {
            // Older relays scanned nested advice too. An advisory-only final read
            // cannot turn their raw code list into a terminal outcome.
            if (
              code === 'COMPOSITION_CONFLICT' &&
              /wouldConflict/.test(c.result) &&
              !resultLines(c.result).some(line => TRIGGERS[0][1].test(line))
            )
              continue;
            if (CODE_TRIGGERS[code]) found.push(CODE_TRIGGERS[code]);
          }
          if (r.conflictMarkers) found.push('conflict');
        }
      }
      if (found.length) {
        if (state !== 'rework') events.reworkEpisodes++;
        state = 'rework';
        events.triggers.push({ turn: i, kinds: [...new Set(found)] });
      } else if (calls.some(c => sourceCall(c)?.kinds.commands.some(f => !f.help) && LANDED.test(c.result))) {
        state = 'done';
        landedAtTurn = i;
      }
    }
    return phase;
  });
  return { turns: turns.length, phases, totals, recovery, events, landedAtTurn, joined };
}

/** Read a task's session (prefix.transcript.jsonl, else prefix.stdout.json) and classify it. */
export function sessionPhases(prefix, { rows = null } = {}) {
  const file = [prefix + '.transcript.jsonl', prefix + '.stdout.json'].find(existsSync);
  if (!file) return { source: 'none', turns: 0, phases: [], totals: null, events: null };
  const entries = jsonLines(readFileSync(file, 'utf8'));
  return {
    source: file.endsWith('.stdout.json') ? 'stream-json' : 'transcript',
    ...classify(sessionTurns(entries), { rows }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [prefix, callLog, task] = process.argv.slice(2);
  if (!prefix) throw Error('usage: phases.mjs PREFIX [CALL_LOG TASK]');
  const rows = callLog
    ? jsonLines(readFileSync(callLog, 'utf8')).filter(r => !task || r.task === task)
    : null;
  const { phases, ...out } = sessionPhases(prefix, { rows });
  console.log(JSON.stringify({ ...out, phaseSequence: phases.join(' ') }, null, 1));
}
