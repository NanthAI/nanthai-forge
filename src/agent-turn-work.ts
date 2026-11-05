// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

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

/** The client's own session id, as both its shell commands and its hooks see it. */
export function turnSessionKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID;
  return value && value.length <= 200 ? value : undefined;
}
export function turnLedgerDirectory() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'forge', 'turns');
}
/** Test processes never touch the developer's real state unless they select one. */
const disabled = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME;
// The file name is a digest: session ids never appear on disk.
const file = (session: string) =>
  join(turnLedgerDirectory(), `${createHash('sha256').update(session).digest('hex').slice(0, 32)}.json`);

/** One local read. A missing or malformed file is an empty ledger. */
export function readTurnLedger(session: string): TurnLedger {
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(file(session), 'utf8')));
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
  renameSync(temporary, file(session));
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
  return update(session, ledger => {
    const entry = entrySchema.parse({ ...work, observedAt: work.observedAt ?? Date.now() });
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
