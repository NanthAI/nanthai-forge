// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AGENT_STAMP_VALUE } from './agent-slug.js';
import { resolveAgentSession } from './agent-session.js';
import { agentSlug } from './agent-slug-session.js';
import { backgroundWake } from './agent-wake.js';
import { turnLedgerDirectory, turnLedgerFile, turnSessionKey } from './agent-turn-state.js';
import { processStartTime } from './local-process.js';
import { invariant } from './errors.js';
import type { AuthorshipClaim } from './work-actor-types.js';

export { turnLedgerDirectory, turnSessionKey };

/** Machine-local ledger of unfinished Forge work an agent session started: one small
 * file per client session, written only by Forge commands that session runs, read once
 * by its turn-end hook. Advisory: every function fails open and never throws. */
const entrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['landing', 'check']),
  root: z.string().min(1),
  /** The canonical wait parameters (no deadline) for this exact operation or run. */
  input: z.record(z.string(), z.unknown()),
  /** The Forge process observing it now; a dead pid means nobody is waiting. */
  pid: z.number().int().nullable(),
  /** The observer's kernel start identity: with the pid it tells a reused pid from the observer. */
  startTime: z.string().optional(),
  /** How the recording client wakes the agent when a background command exits
   * (agent-wake.ts); absent when it does not. */
  wake: z.enum(['background', 'trusted']).optional(),
  observedAt: z.number(),
});
const ledgerSchema = z.object({
  schema: z.literal(1),
  work: z.array(entrySchema).max(32),
  /** Set when the turn-end hook blocked a stop; the next stop attempt is always allowed. */
  blocked: z.object({ id: z.uuid(), at: z.number() }).nullable().optional(),
});
export type TurnWork = z.infer<typeof entrySchema>;
export type TurnLedger = z.infer<typeof ledgerSchema>;
const MAX_ENTRIES = 32;

/** The agent client for landing receipts (81d12a32): the harness, from the same variables that
 * identify its session, and the model when the launcher declared it in `FORGE_AGENT_MODEL` (no
 * harness exposes its model to shell commands). Undefined outside an agent session. */
export function agentClient(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const tool = resolveAgentSession(env)?.harness;
  const declared = env.FORGE_AGENT_MODEL;
  const model = declared && AGENT_STAMP_VALUE.test(declared) ? declared : undefined;
  if (!tool && !model) return undefined;
  return `${tool ?? 'agent'}${model ? `:${model}` : ''}`;
}
const modelSchema = z.object({ schema: z.literal(1), model: z.string().regex(AGENT_STAMP_VALUE) }).strict();
/** A separate Forge record: advisory work-ledger updates cannot overwrite a declaration. */
function sessionModel(session: string, declaration?: string) {
  const path = turnLedgerFile(session).replace(/\.json$/, '.model.json');
  let model: string | undefined;
  try {
    model = modelSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).model;
  } catch {
    /* No declaration. */
  }
  if (declaration !== undefined && declaration !== model && !disabled()) {
    try {
      const directory = turnLedgerDirectory(),
        temporary = join(directory, `.${randomUUID()}`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ schema: 1, model: declaration }), { mode: 0o600 });
      renameSync(temporary, path);
    } catch {
      /* Inheritance is best effort; this command still sends its declaration. */
    }
  }
  return declaration ?? model;
}
/** Only Forge's declaration is read: never another app's session files or a guessed model.
 * The run comes from the same existing session selector used by the transport. */
export function agentAuthorship(
  input: {
    model?: string;
    required?: boolean;
    session?: string | null;
    run?: string;
    fallbackSession?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): { authorship: AuthorshipClaim; agentClient?: string; agentRun?: string; modelDefaulted?: true } {
  const session = resolveAgentSession(env, undefined, input.session);
  if (env.FORGE_HUMAN === '1' || (!session && !input.run && input.session === null))
    return { authorship: { kind: 'person' } };
  const declared = input.model ?? env.FORGE_AGENT_MODEL ?? clientModel(env, session?.harness);
  invariant(
    declared === undefined || AGENT_STAMP_VALUE.test(declared),
    'BAD_ARGUMENT',
    'model must use letters, digits, dot, underscore, slash or hyphen, beginning with a letter or digit (1–64 characters). Set model or FORGE_AGENT_MODEL; use "unknown" when unknown.',
  );
  // Only detected agent apps inherit declarations. A one-off model in a plain shell
  // must not turn later commands in that shell into agent commands.
  const key = session?.harness ? session.key : undefined;
  let model = key ? sessionModel(key, declared) : declared;
  if (!session && !input.run && model === undefined) return { authorship: { kind: 'person' } };
  // A start never refuses for a missing model (6b7d5a79): it records "unknown" and the caller tips once.
  const defaulted = input.required === true && model === undefined;
  if (defaulted) model = 'unknown';
  const app = session?.harness;
  const runKey =
    session?.key ??
    (declared !== undefined && input.fallbackSession ? `declared:${input.fallbackSession}` : undefined);
  const run = input.run ?? (runKey ? agentSlug(runKey) : undefined);
  return {
    authorship: {
      kind: 'agent',
      ...(model === 'unknown'
        ? { declaration: 'unknown' }
        : model === undefined
          ? { declaration: 'not-declared' }
          : {}),
    },
    ...(model && model !== 'unknown'
      ? { agentClient: `${app ?? 'agent'}:${model}` }
      : app
        ? { agentClient: app }
        : {}),
    ...(run ? { agentRun: run } : {}),
    ...(defaulted ? { modelDefaulted: true as const } : {}),
  };
}
/** The model an agent app's own setting names, where the app exposes one to shell commands: Claude Code's
 * ANTHROPIC_MODEL and Gemini CLI's GEMINI_MODEL. A value Forge cannot stamp is ignored, never guessed at. */
function clientModel(env: NodeJS.ProcessEnv, harness: string | undefined) {
  const value =
    harness === 'claude-code' ? env.ANTHROPIC_MODEL : harness === 'gemini' ? env.GEMINI_MODEL : undefined;
  return value && AGENT_STAMP_VALUE.test(value) ? value : undefined;
}
export const MODEL_TIP =
  'Tip: this start recorded model "unknown". Set FORGE_AGENT_MODEL=<your model id> (or pass "model") so receipts and stats name it.';
/** The missing-model tip, once per machine; an unwritable marker shows nothing. */
export function modelTipOnce(): string | undefined {
  if (disabled()) return undefined;
  const file = join(turnLedgerDirectory(), '..', 'model-tip.json');
  try {
    mkdirSync(join(turnLedgerDirectory(), '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ shownAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return MODEL_TIP;
  } catch {
    return undefined;
  }
}
/** Test processes never touch the developer's real state unless they select one. */
const disabled = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME;
/** One local read. A missing or malformed file is an empty ledger. */
export function readTurnLedger(session: string): TurnLedger {
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(turnLedgerFile(session), 'utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    /* missing or unreadable: nothing recorded */
  }
  return { schema: 1, work: [] };
}
function write(session: string, ledger: TurnLedger) {
  const directory = turnLedgerDirectory(),
    temporary = join(directory, `.${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
  renameSync(temporary, turnLedgerFile(session));
}
function update(session: string | undefined, change: (ledger: TurnLedger) => TurnLedger | null) {
  if (!session || disabled()) return false;
  try {
    const next = change(readTurnLedger(session));
    if (next) write(session, next);
    return true;
  } catch {
    return false;
  }
}

/** Record or refresh unfinished work. Running a Forge wait or landing also clears a
 * pending block, so the next stop attempt after real progress is a new first attempt. */
export function recordTurnWork(
  work: Omit<TurnWork, 'observedAt'> & { observedAt?: number },
  session = turnSessionKey(),
) {
  const wake = backgroundWake();
  const startTime = work.startTime ?? (work.pid === null ? undefined : processStartTime(work.pid));
  return update(session, ledger => {
    const entry = entrySchema.parse({
      ...(wake ? { wake } : {}),
      ...work,
      ...(startTime ? { startTime } : {}),
      observedAt: work.observedAt ?? Date.now(),
    });
    return {
      schema: 1,
      work: [entry, ...ledger.work.filter(item => item.id !== entry.id)].slice(0, MAX_ENTRIES),
      blocked: null,
    };
  });
}
/** Forget work that reached a terminal outcome. */
export function settleTurnWork(ids: string[], session = turnSessionKey()) {
  return update(session, ledger => {
    const work = ledger.work.filter(item => !ids.includes(item.id));
    return work.length === ledger.work.length ? null : { ...ledger, work };
  });
}
export function markTurnBlocked(id: string, session: string, now = Date.now()) {
  return update(session, ledger => ({ ...ledger, blocked: { id, at: now } }));
}
export function clearTurnBlocked(session: string) {
  return update(session, ledger => (ledger.blocked ? { ...ledger, blocked: null } : null));
}

/** Work from one wait continuation (`next` of a receipt or wait return). */
export function turnWorkFromWait(
  root: string,
  next: Record<string, unknown> | undefined,
  pid: number | null,
): Omit<TurnWork, 'observedAt'>[] {
  if (!next || next.action !== 'wait') return [];
  // Keep only the targets: a deadline, cursor or explicit address belongs to one call.
  const dropped = new Set(['action', 'timeoutSeconds', 'cursor', 'url', 'projectId']);
  const input = Object.fromEntries(Object.entries(next).filter(([key]) => !dropped.has(key)));
  if (typeof input.runId === 'string')
    return [{ id: input.runId, kind: 'check', root, input: { runId: input.runId }, pid }];
  const ids = Array.isArray(input.operationIds)
    ? input.operationIds.filter(id => typeof id === 'string')
    : [];
  return ids.map(id => ({
    id,
    kind: 'landing' as const,
    root,
    input: { ...input, operationIds: [id] },
    pid,
  }));
}
export function recordTurnWait(root: string, next: Record<string, unknown> | undefined, pid: number | null) {
  for (const work of turnWorkFromWait(root, next, pid)) recordTurnWork(work);
}
