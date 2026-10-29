import { portableCheckEvidence } from './check-compact-output.js';
import { summarizeExecutions } from './check-report-summary.js';
import { readSource } from './files.js';
import {
  portableRun,
  isCheckCachePath,
  runLogRecord,
  isCheckLogPath,
  isCheckReportPath,
} from './check-log-policy.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintPrivateFile, safeRelative } from './files.js';
import {
  recoveryCaptureSchema,
  recoveryCaptureSummary,
  type StoredRecoveryCapture,
  type RecoveryCapture,
} from './recovery-capture.js';
import { pendingRecoverySaves, recoverySaves, type RecoverySave } from './recovery-saves.js';
import { digest } from './hash.js';
import { WorkStore } from './work-store.js';

export type RecoveryEvidence = {
  path: string;
  status: 'covered' | 'pending' | 'unavailable' | 'unknown' | 'provider-held' | 'local-only' | 'expired';
  providerUrl?: string;
  captured: { sha256: string; size: number } | null;
  current: { sha256: string; size: number } | null;
};
export type RecoveryInventory = {
  schema: 1;
  observedAt: string;
  availability: 'available' | 'unknown';
  captures: RecoveryCapture[];
  latestCompleteOffMachine: RecoveryCapture | null;
  latestExport: RecoveryCapture | null;
  pending: {
    workRevision: number;
    saves: RecoverySave[];
    evidence: RecoveryEvidence[];
    oldestPendingAgeMs: number | null;
    oldestKnownPendingAgeMs: number | null;
    unknownSaveTimes: number;
  };
};
/** Read-only local inventory; no network, capture, archive export, check recovery or
 * metadata write. Successful local exports never establish off-machine coverage.
 * Unknown dates and missing/corrupt inventory remain unknown, never zero exposure. */
export async function readRecoveryInventory(root: string, now = Date.now()): Promise<RecoveryInventory> {
  const store = new WorkStore(root, { readOnly: true });
  const captures: StoredRecoveryCapture[] = [];
  let availability: RecoveryInventory['availability'] = 'available';
  const directory = join(store.directory, 'recovery-inventory');
  let entries: import('node:fs').Dirent[] = [];
  try {
    if (existsSync(directory)) entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    availability = 'unknown';
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      captures.push(
        recoveryCaptureSchema.parse(
          JSON.parse(readFileSync(join(directory, entry.name, 'receipt.json'), 'utf8')),
        ),
      );
    } catch {
      availability = 'unknown';
    }
  }
  const newest = (items: StoredRecoveryCapture[]) =>
    items.sort(
      (a, b) =>
        (b.capturedAt ? Date.parse(b.capturedAt) : 0) - (a.capturedAt ? Date.parse(a.capturedAt) : 0) ||
        Date.parse(b.completedAt) - Date.parse(a.completedAt),
    )[0] ?? null;
  const latestCompleteOffMachine =
    availability === 'available'
      ? newest(captures.filter(item => item.offMachine && item.completeHistory === 'complete'))
      : null;
  const latestExport = newest(captures.filter(item => item.kind === 'export'));
  const data = store.observing(() => store.load());
  const saves = pendingRecoverySaves(recoverySaves(data), latestCompleteOffMachine?.saves ?? []).map(
    save => ({
      ...save,
      at:
        save.at &&
        latestCompleteOffMachine?.capturedAt &&
        Date.parse(save.at) <= Date.parse(latestCompleteOffMachine.capturedAt)
          ? null
          : save.at,
    }),
  );
  // A different revision may reflect an un-timestamped replacement or a format/header
  // mutation even when all current record fingerprints match.
  if (latestCompleteOffMachine && data.revision !== latestCompleteOffMachine.workRevision && !saves.length)
    saves.push({ kind: 'work-mutation', id: 'revision', sha256: digest(String(data.revision)), at: null });
  const captured = new Map(latestCompleteOffMachine?.evidence.map(item => [item.path, item]));
  const paths = new Set(captured.keys());
  const artifacts = new Map<string, { sha256: string; size: number }>();
  for (const run of data.runs.map(portableRun)) {
    const prefix = `check-${run.id}/`;
    for (const name of [
      'stdout.log',
      'stderr.log',
      ...(run.endedAt ? ['result.json'] : []),
      ...(run.resourceUsage?.producer ? ['resources.txt'] : []),
    ])
      paths.add(prefix + name);
    for (const artifact of run.artifacts ?? []) {
      const path =
        artifact.status === 'retained' ? `${prefix}artifacts/${artifact.filename}` : artifact.sourcePath;
      paths.add(path);
      if (artifact.status === 'retained') artifacts.set(path, artifact);
    }
  }
  const evidence: RecoveryEvidence[] = [];
  for (const path of paths) {
    if (isCheckCachePath(data, path)) continue;
    const run =
      isCheckLogPath(path) || isCheckReportPath(path)
        ? data.runs.find(run => path.startsWith(`check-${run.id}/`))
        : undefined;
    const disposition = run ? runLogRecord(data, run, now) : undefined;
    if (disposition && disposition.status !== 'included') {
      evidence.push({
        path,
        status: disposition.status,
        captured: null,
        current: null,
        ...('providerUrl' in disposition ? { providerUrl: disposition.providerUrl } : {}),
      });
      continue;
    }
    const prior = captured.get(path);
    let current: RecoveryEvidence['current'] = null;
    if (safeRelative(path) && path.startsWith('check-')) {
      try {
        const absolute = join(store.directory, path);
        if (path.endsWith('/test-evidence.json')) {
          const bytes = portableCheckEvidence(join(store.directory, path.slice(0, -19)));
          if (bytes) current = { sha256: digest(bytes), size: bytes.length };
        } else if (path.endsWith('/modal-shard-logs.json')) {
          const original = readSource(store.directory, path, Number.MAX_SAFE_INTEGER);
          if (original) {
            const bytes = summarizeExecutions(original);
            current = { sha256: digest(bytes), size: bytes.length };
          }
        } else if (realpathSync(absolute) === absolute) {
          const observed = await fingerprintPrivateFile(absolute);
          if (realpathSync(absolute) === absolute) current = observed;
        }
      } catch {
        /* Missing/changing evidence remains explicit. */
      }
    }
    const pin = prior?.pin ?? null;
    const expected = artifacts.get(path);
    const same = (a: RecoveryEvidence['current'], b: RecoveryEvidence['current']) =>
      !!a && !!b && a.sha256 === b.sha256 && a.size === b.size;
    evidence.push({
      path,
      captured: pin,
      current,
      status: expected
        ? same(pin, expected)
          ? 'covered'
          : same(current, expected)
            ? 'pending'
            : 'unavailable'
        : same(pin, current)
          ? 'covered'
          : current
            ? 'pending'
            : prior?.status === 'unavailable'
              ? 'unavailable'
              : 'unknown',
    });
  }
  const ages = saves.flatMap(save => (save.at ? [Math.max(0, now - Date.parse(save.at))] : []));
  const unknownSaveTimes = saves.filter(save => !save.at).length;
  const evidencePending = evidence.some(item => ['pending', 'unavailable', 'unknown'].includes(item.status));
  const oldestKnownPendingAgeMs = ages.length ? Math.max(...ages) : null;
  return {
    schema: 1,
    observedAt: new Date(now).toISOString(),
    availability,
    captures: captures.map(recoveryCaptureSummary),
    latestCompleteOffMachine: latestCompleteOffMachine
      ? recoveryCaptureSummary(latestCompleteOffMachine)
      : null,
    latestExport: latestExport ? recoveryCaptureSummary(latestExport) : null,
    pending: {
      workRevision: data.revision,
      saves,
      evidence,
      unknownSaveTimes,
      oldestKnownPendingAgeMs,
      oldestPendingAgeMs:
        unknownSaveTimes ||
        evidencePending ||
        !latestCompleteOffMachine ||
        !latestCompleteOffMachine.capturedAt
          ? null
          : (oldestKnownPendingAgeMs ?? 0),
    },
  };
}
