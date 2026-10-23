// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { commitExchangeDirectory } from './native-exchange-files.js';
import { recoverySaves } from './recovery-saves.js';
import { sourceManifestSchema } from './work-archive-metadata.js';
import type { WorkStore } from './work-store.js';

const pin = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() });
export const recoveryCaptureSchema = z.object({
  schema: z.literal(1),
  id: z.string().uuid(),
  kind: z.enum(['exchange', 'export']),
  capturedAt: z.string().datetime().nullable(),
  evidenceCapturedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime(),
  offMachine: z.boolean(),
  completeHistory: z.enum(['complete', 'incomplete', 'unknown']),
  backupId: z.string().nullable(),
  sourceHead: z.string(),
  mainHead: z.string().nullable(),
  workRevision: z.number().int().nonnegative(),
  work: pin,
  manifest: pin,
  evidence: z.array(
    z.object({ path: z.string(), status: z.enum(['included', 'unavailable']), pin: pin.nullable() }),
  ),
  saves: z.array(
    z.object({
      kind: z.enum(['checkpoint', 'check-completion', 'work-mutation']),
      id: z.string(),
      at: z.string().nullable(),
      sha256: z.string(),
    }),
  ),
});
export type StoredRecoveryCapture = z.infer<typeof recoveryCaptureSchema>;
export type RecoveryCapture = Omit<StoredRecoveryCapture, 'saves'>;
export function recoveryCaptureSummary(value: StoredRecoveryCapture): RecoveryCapture {
  const { saves, ...summary } = value;
  void saves;
  return summary;
}
export type RecoveryReceipt =
  | { status: 'recorded'; capture: RecoveryCapture }
  | { status: 'unavailable'; code: 'RECOVERY_INVENTORY_UNAVAILABLE' };
export function recoveryTiming(directory: string): {
  capturedAt: string | null;
  evidenceCapturedAt: string | null;
} {
  const path = join(directory, 'recovery-timing.json');
  if (!existsSync(path)) return { capturedAt: null, evidenceCapturedAt: null };
  return z
    .object({
      capturedAt: z.string().datetime().nullable(),
      evidenceCapturedAt: z.string().datetime().nullable(),
    })
    .parse(JSON.parse(readFileSync(path, 'utf8')));
}
/** Local observation only. Exports are not evidence of an off-machine copy. This
 * sidecar never changes Work, the exchange payload or a successful publication. */
export function retainRecoveryCapture(
  store: WorkStore,
  directory: string,
  manifestPin: { sha256: string; size: number },
  options: {
    kind: 'exchange' | 'export';
    backupId?: string;
    completeHistory?: RecoveryCapture['completeHistory'];
  },
): RecoveryReceipt {
  try {
    const manifest = sourceManifestSchema.parse(
      JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')),
    );
    const incomplete = join(
      store.directory,
      'recovery-inventory',
      `exchange-${manifest.id}-incomplete`,
      'receipt.json',
    );
    const history =
      options.completeHistory ??
      (options.kind === 'exchange' && existsSync(incomplete) ? 'incomplete' : 'complete');
    const target = join(store.directory, 'recovery-inventory');
    const destination = join(target, `${options.kind}-${manifest.id}-${history}`);
    const existing = () => ({
      status: 'recorded' as const,
      capture: recoveryCaptureSummary(
        recoveryCaptureSchema.parse(JSON.parse(readFileSync(join(destination, 'receipt.json'), 'utf8'))),
      ),
    });
    if (existsSync(join(destination, 'receipt.json'))) return existing();
    const data = JSON.parse(readFileSync(join(directory, 'work.json'), 'utf8'));
    const work = manifest.files.find(file => file.path === 'work.json');
    const timing = recoveryTiming(directory);
    const capture = recoveryCaptureSchema.parse({
      schema: 1,
      id: manifest.id,
      kind: options.kind,
      ...timing,
      completedAt: new Date().toISOString(),
      offMachine: options.kind === 'exchange',
      completeHistory: history,
      backupId: options.backupId ?? null,
      sourceHead: manifest.head,
      mainHead:
        data.channelMoves?.filter((channel: { channel: string }) => channel.channel === 'main').at(-1)
          ?.head ?? null,
      workRevision: manifest.revision,
      work,
      manifest: manifestPin,
      evidence: [
        ...manifest.files
          .filter(file => file.path.startsWith('check-'))
          .map(file => ({
            path: file.path,
            status: history === 'incomplete' ? 'unavailable' : 'included',
            pin: history === 'incomplete' ? null : file,
          })),
        ...manifest.unavailable.map(path => ({ path, status: 'unavailable', pin: null })),
      ],
      saves: recoverySaves(data),
    });
    // Hash the pinned records outside the owner lock. Only receipt publication is serialized.
    return store.locked(() => {
      if (existsSync(join(destination, 'receipt.json'))) return existing();
      mkdirSync(target, { recursive: true, mode: 0o700 });
      commitExchangeDirectory(destination, { 'receipt.json': JSON.stringify(capture) });
      return { status: 'recorded' as const, capture: recoveryCaptureSummary(capture) };
    });
  } catch {
    return { status: 'unavailable', code: 'RECOVERY_INVENTORY_UNAVAILABLE' };
  }
}
