// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, renameSync, lstatSync, realpathSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { serverRecoveryAuthority } from './recovery-authority.js';
import { deploymentUrl } from './auth-store.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { withQueueSlot } from './landing-queue.js';
import { checkoutHostedMain } from './hosted-main-checkout.js';
import { hostedMainSchema } from './hosted-main.js';
import { hostedMacRunnerSchema } from './hosted-check.js';
import {
  recoveryRequestSchema,
  recoverySelectionSchema,
  sameRecoveryPins,
  type RecoverySelection,
} from './recovery-protocol.js';
import { foldHostedRecoveryCache } from './recovery-hosted.js';
import { hostedRecoverySchema, type HostedRecovery } from './recovery-hosted-protocol.js';
import { writeRecoveryState } from './recovery-state.js';
import { validateRunnerRecovery } from './recovery-runner-cache.js';
import { syncDirectory } from './native-durability.js';
import { runnerRecoveryTransport, type RunnerRecoveryTransport } from './recovery-runner-transport.js';

export type HostedMacRunner = z.infer<typeof hostedMacRunnerSchema>;
const requestSchema = recoveryRequestSchema.omit({ archivePath: true, cacheRoot: true });
type Progress = {
  schema: 1;
  requestHash: string;
  selection: RecoverySelection;
  configuration: HostedMacRunner;
  ready?: boolean;
  hosted?: HostedRecovery | undefined;
  registration?: unknown;
  complete?: boolean;
  timings: Record<string, number>;
};
export const recoveryRunnerTestHooks: { afterPublish?: () => void } = {};
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** Route B never constructs native Work, an owner binding or acceptance authority. */
export async function recoverRunner(target: string, input: unknown, supplied?: RunnerRecoveryTransport) {
  const parsed = requestSchema.parse(input),
    request = { ...parsed, url: deploymentUrl(parsed.url) },
    parent = realpathSync(dirname(resolve(target))),
    root = join(parent, basename(resolve(target))),
    requestHash = digest(JSON.stringify({ root, request })),
    directory = join(parent, `.forge-recovery-${digest(root).slice(0, 12)}-${request.operationId}`),
    path = join(directory, 'runner.json'),
    stage = join(directory, 'cache');
  invariant(
    !existsSync(root) || existsSync(path),
    'RESTORE_TARGET_EXISTS',
    'Choose a fresh recovery destination; existing work is preserved.',
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  invariant(
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
    'UNSAFE_PATH',
    'Recovery staging must be a real directory.',
  );
  const queued = await withQueueSlot(
    join(directory, 'queue'),
    async () => {
      invariant(
        !existsSync(join(directory, 'state.json')),
        'WORK_OPERATION_CHANGED',
        'This operation already selected native recovery; retain its original route.',
      );
      const transport = supplied ?? runnerRecoveryTransport(request);
      let progress: Progress | undefined = existsSync(path) ? read(path) : undefined;
      invariant(
        !progress || (progress.schema === 1 && progress.requestHash === requestHash),
        'WORK_OPERATION_CHANGED',
        'Replay the original recovery request and destination.',
      );
      const start = performance.now();
      // Recheck current access before every cache hit, even if hosted has advanced.
      const prepared = z
        .object({ selection: recoverySelectionSchema.nullable() })
        .parse(await transport.prepare());
      invariant(
        prepared.selection?.projectId === request.projectId,
        'WORK_STALE',
        'Select this existing project with a fresh recovery operation.',
      );
      invariant(
        serverRecoveryAuthority({ binding: { sourceAuthority: prepared.selection.authority } }) ||
          progress?.complete,
        'SOURCE_AUTHORITY_STALE',
        'Native-owner recovery remains available; runner/cache recovery requires server authority.',
      );
      const markerPath = join(root, '.forge', 'recovery-runner.json');
      // Reconcile an interrupted final rename before accessing the vanished stage.
      if (existsSync(root)) {
        invariant(
          existsSync(markerPath) && read(markerPath).requestHash === requestHash,
          'RESTORE_TARGET_EXISTS',
          'Unrelated destination files remain preserved.',
        );
        invariant(
          progress?.ready && progress.registration,
          'INVALID_WORK_BACKUP',
          'Retain the original recovery journal and published cache.',
        );
        progress.complete = true;
        writeRecoveryState(path, progress);
        return result(progress);
      }
      invariant(
        !progress?.complete,
        'RECOVERY_STATE_UNAVAILABLE',
        'The recovered cache is unavailable; retain the original destination.',
      );
      if (!progress) {
        progress = {
          schema: 1,
          requestHash,
          selection: prepared.selection,
          configuration: hostedMacRunnerSchema.parse(await transport.configuration()),
          timings: { select: Math.round(performance.now() - start) },
        };
        writeRecoveryState(path, progress);
      }
      const selected = progress.selection;
      if (!progress.ready) {
        invariant(
          sameRecoveryPins(selected, prepared.selection),
          'WORK_STALE',
          'Hosted recovery pins changed; original staged files remain preserved.',
        );
        const main = hostedMainSchema.parse(await transport.current());
        invariant(
          main.projectId === request.projectId &&
            (!selected.hostedMain || JSON.stringify(main) === JSON.stringify(selected.hostedMain)),
          'WORK_STALE',
          'Hosted main changed from the selected recovery snapshot.',
        );
        const checkoutStart = performance.now();
        await checkoutHostedMain(
          stage,
          { ...request, expected: { head: main.head, receiptId: main.receipt.id } },
          transport,
        );
        progress.timings.checkout = Math.round(performance.now() - checkoutStart);
        const foldStart = performance.now();
        progress.hosted = await foldHostedRecoveryCache(directory, stage, selected, transport);
        progress.timings.fold = Math.round(performance.now() - foldStart);
        const latest = z
          .object({ selection: recoverySelectionSchema.nullable() })
          .parse(await transport.prepare());
        invariant(
          latest.selection && sameRecoveryPins(latest.selection, selected),
          'WORK_STALE',
          'Hosted recovery pins changed; staged files remain preserved.',
        );
        progress.ready = true;
        writeRecoveryState(path, progress);
      }
      // Validate immutable staged receipts on a retry without reading a newer
      // snapshot or replaying a hosted acceptance/completion operation.
      const validateStart = performance.now();
      if (progress.hosted) {
        const recovery = hostedRecoverySchema.parse(progress.hosted);
        await validateRunnerRecovery(directory, stage, recovery);
      }
      invariant(
        !existsSync(join(stage, '.forge', 'native.json')),
        'INVALID_WORK_BACKUP',
        'A runner cache must not contain a native owner marker.',
      );
      progress.timings.validate = Math.round(performance.now() - validateStart);
      const registerStart = performance.now();
      const registration = await transport.register({
        operationId: request.operationId,
        authorityEpoch: selected.authority.epoch,
        configuration: progress.configuration,
      });
      const receipt = z
        .object({
          status: z.literal('completed'),
          result: z
            .object({
              projectId: z.literal(request.projectId),
              machineId: z.literal(progress.configuration.machineId),
              sessionId: z.literal(request.operationId),
              keyId: z.string(),
              configuration: z.string(),
            })
            .passthrough(),
        })
        .parse(registration);
      progress.registration = receipt;
      progress.timings.register = Math.round(performance.now() - registerStart);
      writeRecoveryState(path, progress);
      writeRecoveryState(join(stage, '.forge', 'recovery-runner.json'), {
        requestHash,
        address: { url: request.url, projectId: request.projectId },
        selection: selected,
        hosted: progress.hosted,
        registration: receipt,
        configuration: progress.configuration,
      });
      const publishStart = performance.now();
      // Reserve before rename: a concurrent unrelated destination cannot be replaced.
      mkdirSync(root, { mode: 0o700 });
      try {
        renameSync(stage, root);
      } catch (error) {
        try {
          rmdirSync(root);
        } catch {
          /* Preserve concurrent files. */
        }
        throw error;
      }
      syncDirectory(parent);
      recoveryRunnerTestHooks.afterPublish?.();
      progress.timings.publish = Math.round(performance.now() - publishStart);
      progress.complete = true;
      writeRecoveryState(path, progress);
      return result(progress);

      function result(state: Progress) {
        return {
          restored: true,
          role: 'runner-cache',
          root,
          operationId: request.operationId,
          registration: state.registration,
          configuration: state.configuration,
          coverage: {
            main: state.selection.hostedMain ?? read(join(root, '.forge', 'hosted-main.json')).selection,
            hosted: state.hosted ?? null,
            completeHistory: state.selection.completeHistory,
          },
          timings: state.timings,
          staging: directory,
          message:
            'Recovered a runner and verified hosted cache. Source and acceptance remain hosted; no commands restarted.',
          undo: 'Keep or remove this disposable cache; stop the worker with Ctrl+C. Hosted source, Work and acceptance are unchanged.',
        };
      }
    },
    { anchor: directory },
  );
  return 'value' in queued ? queued.value : queued;
}
