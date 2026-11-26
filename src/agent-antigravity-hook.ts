// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Antigravity's first-write and turn-end hook (Issues c6615b66, d0e9ce11). Its hook contract differs
// from Claude Code's (bundled docs `agy-customizations/docs/hooks.md`, confirmed with a test hook
// under `agy -p` and `agy acp`, CLI 1.5.13):
// - a PreToolUse reply must carry `decision`; `{}` denies the tool, `allow` auto-approves past the
//   user's permission rules, and an unknown field fails the tool. So Forge never answers PreToolUse.
// - an allow `reason` never reaches the model; only `injectSteps` of PreInvocation does.
// - Stop uses camelCase input (`hookEventName`, `conversationId`, `terminationReason`, `cwd`,
//   `workspacePaths`) and blocks a stop with `{ decision: "continue", reason }`; `{}` allows stop.
// So the write check runs after the write (PostToolUse, reply `{}`) and the notice waits in a local
// file until the next model call (PreInvocation), which injects it once. Node builtins only on the
// PreInvocation path: it runs before every model call. Stop lazily loads the shared turn-end guard
// and snapshot only when a turn finishes.
import { isMainModule } from '../scripts/main-module.mjs';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ANTIGRAVITY_EDIT_TOOLS } from './agent-antigravity-tools.js';

const PENDING_CHARS = 1800;
const STALE_MS = 24 * 3_600_000;

const pendingDirectory = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'forge', 'antigravity-notices');
const pendingFile = (conversation: string) =>
  join(pendingDirectory(), createHash('sha256').update(conversation).digest('hex').slice(0, 32) + '.txt');
type Run = (input: Record<string, unknown>) => unknown;
type StopSnapshot = (input: {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
}) => Promise<unknown>;
type Input = {
  hookEventName?: unknown;
  conversationId?: unknown;
  cwd?: unknown;
  workspacePaths?: unknown;
  terminationReason?: unknown;
  continuationActive?: unknown;
  toolCall?: { name?: unknown; args?: Record<string, unknown> };
};
const NORMAL_STOP_REASONS = new Set(['', 'NO_TOOL_CALL', 'model_stop']);

/** Paths a write tool names: path-like arguments and patch headers. */
function writtenPaths(args: Record<string, unknown> | undefined) {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(args ?? {}))
    if (typeof value === 'string') {
      if (/^(?:Path|TargetFile|AbsolutePath|FilePath|path|file_path)$/.test(key)) paths.push(value);
      for (const match of value.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm))
        paths.push(match[1]!);
    }
  return paths;
}

function deliver(conversation: string) {
  const file = pendingFile(conversation);
  let text: string;
  try {
    // Claim the notice first, so two model calls never inject it twice.
    const claimed = `${file}.${process.pid}.claimed`;
    renameSync(file, claimed);
    text = readFileSync(claimed, 'utf8');
    unlinkSync(claimed);
  } catch {
    return {};
  }
  return text.trim() ? { injectSteps: [{ systemMessage: { systemMessage: text.trim() } }] } : {};
}

function remember(conversation: string, context: string) {
  const directory = pendingDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Notices for conversations that ended before their next model call are dropped after a day.
  const now = Date.now();
  for (const name of readdirSync(directory))
    try {
      if (now - statSync(join(directory, name)).mtimeMs > STALE_MS) unlinkSync(join(directory, name));
    } catch {
      /* Another hook removed it. */
    }
  const file = pendingFile(conversation);
  let before = '';
  try {
    before = readFileSync(file, 'utf8');
  } catch {
    /* First notice for this conversation. */
  }
  const lines = [...new Set([...before.split('\n'), ...context.split('\n')].filter(Boolean))];
  writeFileSync(file, lines.join('\n').slice(0, PENDING_CHARS), { mode: 0o600 });
}

async function handleStop(
  input: Input,
  options?: { snapshot?: StopSnapshot; env?: NodeJS.ProcessEnv },
): Promise<object> {
  const { editHooksEnabled } = await import('./agent-hook-settings.js');
  if (!editHooksEnabled()) return {};
  // Never force continuation on user cancel, errors, invocation/token limits, or custom terminations.
  if (typeof input.terminationReason === 'string' && !NORMAL_STOP_REASONS.has(input.terminationReason))
    return {};
  const conversation = typeof input.conversationId === 'string' ? input.conversationId : '';
  const cwd =
    typeof input.cwd === 'string' && input.cwd
      ? input.cwd
      : Array.isArray(input.workspacePaths) &&
          typeof input.workspacePaths[0] === 'string' &&
          input.workspacePaths[0]
        ? input.workspacePaths[0]
        : undefined;
  const { turnLedgerIdle } = await import('./agent-turn-state.js');
  let sessionId: string | undefined;
  if (conversation && !turnLedgerIdle(conversation)) sessionId = conversation;
  else {
    // Antigravity does not expose conversationId in shell env; fall back to the Antigravity or
    // T3 Code session key that Forge CLI commands record under when no explicit override was set.
    const { resolveAgentSession } = await import('./agent-session.js');
    const env = options?.env ?? process.env;
    const envSession = env.FORGE_AGENT_SESSION ? undefined : resolveAgentSession(env);
    if (
      envSession &&
      (envSession.harness === 'antigravity' || envSession.harness === 't3-code') &&
      !turnLedgerIdle(envSession.key)
    )
      sessionId = envSession.key;
    else if (conversation) sessionId = conversation;
  }
  const { turnEndWithSnapshot } = await import('./agent-stop-hook.js');
  const decision = await turnEndWithSnapshot(
    {
      ...(sessionId ? { session_id: sessionId } : {}),
      hook_event_name: 'Stop',
      ...(cwd ? { cwd } : {}),
    },
    options?.snapshot,
  );
  return decision.decision === 'block'
    ? { decision: 'continue', ...(decision.reason ? { reason: decision.reason } : {}) }
    : {};
}

/** One hook process: never throws, always answers with a reply Antigravity accepts. */
export async function antigravityHook(
  input: Input,
  run?: Run,
  options?: { snapshot?: StopSnapshot; env?: NodeJS.ProcessEnv },
): Promise<object> {
  try {
    // Any JSON value can arrive (`null`, a number): only an object is a hook input.
    if (!input || typeof input !== 'object') return {};
    const conversation = typeof input.conversationId === 'string' ? input.conversationId : '';
    if (input.hookEventName === 'PreInvocation') return conversation ? deliver(conversation) : {};
    if (input.hookEventName === 'Stop') return await handleStop(input, options);
    const tool = input.toolCall;
    if (
      input.hookEventName !== 'PostToolUse' ||
      !conversation ||
      !(ANTIGRAVITY_EDIT_TOOLS as readonly unknown[]).includes(tool?.name)
    )
      return {};
    const paths = writtenPaths(tool?.args);
    if (!paths.length) return {};
    // The Claude-shaped request the shared first-write check already reads: paths, cwd, session.
    const request = { cwd: input.cwd, session_id: conversation, tool_name: 'Write', tool_input: {}, paths };
    const runner =
      run ?? (await import('./agent-edit-hook.js')).runEditHook.bind(null, '--auto', 'antigravity');
    const output = (await runner(request)) as { hookSpecificOutput?: { additionalContext?: unknown } } | null;
    const context = output?.hookSpecificOutput?.additionalContext;
    if (typeof context === 'string' && context) remember(conversation, context);
  } catch {
    /* Fail open: never block writes or stops on hook error. */
  }
  return {};
}

if (isMainModule(import.meta.url)) {
  let input: Input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as Input;
  } catch {
    /* Malformed input: answer the neutral reply. */
  }
  process.stdout.write(JSON.stringify(await antigravityHook(input)) + '\n');
  if (input && typeof input === 'object' && input.hookEventName === 'Stop') process.exit(0);
}
