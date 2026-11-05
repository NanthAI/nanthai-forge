// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { privateJson } from './legacy-storage-journal.mjs';
export async function resumeWrites(io, operationId) {
  const flagNames = ['FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE'];
  if (!operationId) {
    if (!(await io.flagsAbsent())) throw new Error('CLEANUP_WINDOW_ID_REQUIRED');
    return { flagsAbsent: true, flagNames, absenceVerifiedAt: Date.now() };
  }
  const closed = await io.endWindow(operationId);
  if (!closed?.ended) throw new Error('CLEANUP_FENCE_RESUME_FAILED');
  await Promise.allSettled(flagNames.map(name => io.unsetFlag(name)));
  const flagsUnsetAt = Date.now();
  if (!(await io.flagsAbsent())) throw new Error('CLEANUP_RESUME_FAILED');
  return { flagsAbsent: true, flagNames, flagsUnsetAt, absenceVerifiedAt: Date.now() };
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
    resuming,
    resumeProof,
    resumedAt,
    timer;
  const resume = () =>
    (resuming ??= resumeWrites(io, command.operationId).then(result => {
      resumeProof = result;
      resumedAt = result.flagsUnsetAt ?? Date.now();
      return result;
    }));
  const interrupt = () => {
    interrupted = true;
    io.stop?.();
    if (timer)
      void resume().catch(() => {
        resuming = undefined;
      });
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
    let resumeFailed = false;
    try {
      await resume();
    } catch {
      resumeFailed = true;
    }
    const absent = resumeProof?.flagsAbsent ?? (await io.flagsAbsent().catch(() => false)),
      endedAt = absent && !resumeFailed ? (resumedAt ?? Date.now()) : null;
    await privateJson(command.out + '/window.json', {
      ...pause,
      leadGo: command.leadGo,
      endedAt,
      elapsedMs: endedAt === null ? null : endedAt - startedAt,
      status: absent && !resumeFailed ? 'ended' : 'resume-failed',
      flagsAbsent: absent,
      absenceVerifiedAt: Date.now(),
      flagNames: ['FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE'],
      failed: !!error,
      pausedOperations: ['dev database mutations', 'new R2 write signatures'],
    });
    io.progress?.({
      phase: 'pause-ended',
      endedAt,
      flagsAbsent: absent,
      flagNames: ['FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE'],
    });
    if (!absent || resumeFailed) throw new Error('CLEANUP_RESUME_FAILED');
  }
  if (error) throw error;
  return result;
}
