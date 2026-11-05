// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { privateJson } from './legacy-storage-journal.mjs';
export const FLAG_NAMES = Object.freeze(['FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE']);
export const RESUME_RETRY = Object.freeze({
  fenceAttempts: 3,
  fenceDelaysMs: Object.freeze([1_000, 3_000]),
  proofRounds: 6,
  proofDelaysMs: Object.freeze([500, 1_000, 2_000, 4_000, 8_000]),
});
const sleep = ms => new Promise(done => setTimeout(done, ms));
/** Structured error codes and provider exit evidence only; never raw messages. */
export function errorEvidence(error) {
  if (!error) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  return {
    code: /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'UNCLASSIFIED',
    ...(error.head ? { head: error.head } : {}),
    ...(error.provider ? { provider: error.provider } : {}),
    ...(error.workFailure ? { workFailure: error.workFailure } : {}),
  };
}
/** Name-only present flags; null when the proof itself failed. */
async function presentFlags(io) {
  if (io.flagsPresent) return (await io.flagsPresent()).filter(name => FLAG_NAMES.includes(name));
  return (await io.flagsAbsent()) ? [] : null;
}
/** Close the fence (bounded retries), then remove flags one at a time and prove
 * name-only absence in a bounded loop. A name whose removal reported success is
 * given one more proof round for delayed visibility before it is removed again.
 * Every fence, removal and proof outcome is retained. Flags are removed even if
 * the fence could not be confirmed: every owned page has already settled, and
 * deletion also requires the matching active pause flag. */
export async function resumeWrites(io, operationId, options = {}) {
  const retry = { ...RESUME_RETRY, ...options },
    wait = options.sleep ?? sleep,
    evidence = { fence: [], removals: [], proofs: [], fenceClosed: !operationId };
  if (operationId) {
    for (let attempt = 1; attempt <= retry.fenceAttempts && !evidence.fenceClosed; attempt++) {
      if (attempt > 1) await wait(retry.fenceDelaysMs[Math.min(attempt - 2, retry.fenceDelaysMs.length - 1)]);
      try {
        const closed = await io.endWindow(operationId);
        evidence.fenceClosed = closed?.ended === true;
        evidence.fence.push({ attempt, at: Date.now(), ended: evidence.fenceClosed });
      } catch (error) {
        evidence.fence.push({ attempt, at: Date.now(), ended: false, error: errorEvidence(error) });
      }
    }
  }
  let present = null,
    flagsUnsetAt = null,
    removedLastRound = new Set();
  for (let round = 1; round <= retry.proofRounds; round++) {
    try {
      present = await presentFlags(io);
      evidence.proofs.push({ round, at: Date.now(), present });
    } catch (error) {
      present = null;
      evidence.proofs.push({ round, at: Date.now(), present: null, error: errorEvidence(error) });
    }
    if (present?.length === 0) break;
    if (round === retry.proofRounds) break;
    const removedThisRound = new Set();
    for (const name of present ?? FLAG_NAMES) {
      if (removedLastRound.has(name)) continue; // Delayed visibility: prove once more first.
      try {
        await io.unsetFlag(name);
        removedThisRound.add(name);
        flagsUnsetAt = Date.now();
        evidence.removals.push({ round, name, at: flagsUnsetAt, ok: true });
      } catch (error) {
        evidence.removals.push({ round, name, at: Date.now(), ok: false, error: errorEvidence(error) });
      }
    }
    removedLastRound = removedThisRound;
    await wait(retry.proofDelaysMs[Math.min(round - 1, retry.proofDelaysMs.length - 1)]);
  }
  const flagsAbsent = present?.length === 0;
  const proof = {
    flagsAbsent,
    flagNames: [...FLAG_NAMES],
    flagsUnsetAt,
    absenceVerifiedAt: flagsAbsent ? Date.now() : null,
    fenceClosed: evidence.fenceClosed,
    resume: evidence,
  };
  if (!flagsAbsent || !evidence.fenceClosed)
    throw Object.assign(new Error(flagsAbsent ? 'CLEANUP_FENCE_RESUME_FAILED' : 'CLEANUP_RESUME_FAILED'), {
      proof,
    });
  return proof;
}
/** This function is invoked only after the lead's separate go. Any failure
 * unwinds the pause before returning an error for investigation. */
export async function maintenanceWindow(command, work, io) {
  if (!command.leadGo?.trim()) throw new Error('CLEANUP_LEAD_GO_REQUIRED');
  if (!io.beginWindow || !io.endWindow) throw new Error('CLEANUP_FENCE_REQUIRED');
  if (!(await io.flagsAbsent())) throw new Error('CLEANUP_FLAGS_ALREADY_SET');
  try {
    await readFile(command.out + '/window.json');
    throw new Error('CLEANUP_WINDOW_ALREADY_USED');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const startedAt = Date.now(),
    pause = {
      deployment: command.deployment,
      operationId: command.operationId,
      startedAt,
      expiresAt: startedAt + 30 * 60_000,
    };
  await privateJson(command.out + '/window.json', { ...pause, leadGo: command.leadGo, status: 'starting' });
  let result,
    error,
    interrupted = false,
    fenceEarly,
    timer;
  const interrupt = () => {
    interrupted = true;
    io.stop?.();
    // Close the fence at once so in-flight pages conflict; flags are removed
    // after every owned page settles (finally below).
    if (timer && !fenceEarly)
      fenceEarly = Promise.resolve()
        .then(() => io.endWindow(command.operationId))
        .then(
          r => ({ at: Date.now(), ended: r?.ended === true }),
          e => ({ at: Date.now(), ended: false, error: errorEvidence(e) }),
        );
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await io.setFlag('FORGE_LEGACY_STORAGE_PAUSE', JSON.stringify(pause));
    if (interrupted) throw new Error('CLEANUP_INTERRUPTED');
    await io.setFlag('FORGE_R2_MAINTENANCE', '1');
    if (interrupted) throw new Error('CLEANUP_INTERRUPTED');
    await io.beginWindow(command.operationId);
    if (interrupted) throw new Error('CLEANUP_INTERRUPTED');
    io.progress?.({
      phase: 'pause-started',
      startedAt,
      expiresAt: pause.expiresAt,
      pausedOperations: ['dev database mutations', 'new R2 write signatures'],
    });
    timer = setTimeout(interrupt, Math.max(1, pause.startedAt + 26 * 60_000 - Date.now()));
    result = await work(pause);
    if (interrupted) throw new Error('CLEANUP_INTERRUPTED');
  } catch (e) {
    error = e;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const attempts = [],
      early = fenceEarly ? await fenceEarly : null;
    let proof = null;
    // One in-process resume plus one outer recovery; each is itself bounded.
    for (let attempt = 1; attempt <= 2 && !proof; attempt++) {
      try {
        proof = await resumeWrites(io, command.operationId, command.resumeRetry);
        attempts.push({ attempt, ok: true, resume: proof.resume });
      } catch (e) {
        attempts.push({ attempt, ok: false, error: errorEvidence(e), resume: e.proof?.resume ?? null });
        if (e.proof?.flagsAbsent && attempt === 2) proof = { ...e.proof, failed: e };
      }
    }
    const absent = proof?.flagsAbsent === true,
      fenceClosed = proof?.fenceClosed === true,
      endedAt = absent ? (proof.flagsUnsetAt ?? proof.absenceVerifiedAt) : null;
    await privateJson(command.out + '/window.json', {
      ...pause,
      leadGo: command.leadGo,
      endedAt,
      elapsedMs: endedAt === null ? null : endedAt - startedAt,
      status: absent && fenceClosed ? 'ended' : absent ? 'fence-unconfirmed' : 'resume-failed',
      flagsAbsent: absent,
      fenceClosed,
      absenceVerifiedAt: proof?.absenceVerifiedAt ?? null,
      flagNames: [...FLAG_NAMES],
      failed: !!error,
      workFailure: errorEvidence(error),
      earlyFence: early,
      resumeAttempts: attempts,
      pausedOperations: ['dev database mutations', 'new R2 write signatures'],
    });
    io.progress?.({
      phase: 'pause-ended',
      endedAt,
      flagsAbsent: absent,
      fenceClosed,
      flagNames: [...FLAG_NAMES],
      workFailure: errorEvidence(error)?.code ?? null,
    });
    if (!absent || !fenceClosed) {
      // Never mask the original work failure behind the resume failure.
      const failure = new Error(absent ? 'CLEANUP_FENCE_RESUME_FAILED' : 'CLEANUP_RESUME_FAILED');
      failure.workFailure = errorEvidence(error)?.code ?? null;
      failure.cause = error;
      throw failure;
    }
  }
  if (error) throw error;
  return result;
}
