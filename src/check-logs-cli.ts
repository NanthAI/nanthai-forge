// SPDX-License-Identifier: Apache-2.0
import { downloadArchiveFile, type ArchivePart } from './archive-download-file.js';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { WorkStore } from './work-store.js';
import { cleanLocalCheckLogs, localCheckLogPlan } from './check-log-cleanup.js';
import { requireHostedBinding } from './host-binding.js';
import { coordinationClient } from './coordination-client.js';
import { ConvexExchange } from './exchange-client.js';
import { migrateNativeArchive } from './native-exchange-migrate.js';
import { ConvexError } from 'convex/values';
import { continueLongAction } from './long-action.js';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { durableReplace } from './native-durability.js';

const help = 'nforge maintenance check-logs ROOT --dry-run|--apply --plan FILE [--hosted]';
/** One-off owner command. Dry-run records the exact local/hosted scope; apply
 * reuses that UUID and can resume unknown hosted outcomes without deleting twice. */
export async function checkLogsCli(args: string[]) {
  if (args.includes('--help')) return { usage: help };
  const root = args.shift();
  let apply = false,
    hosted = false,
    planPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--dry-run') apply = false;
    else if (args[i] === '--hosted') hosted = true;
    else if (args[i] === '--plan') planPath = args[++i];
    else invariant(false, 'BAD_ARGUMENT', help);
  }
  invariant(root && planPath, 'BAD_ARGUMENT', help);
  const store = new WorkStore(resolve(root));
  const binding = hosted ? requireHostedBinding(store) : undefined;
  const client = binding ? coordinationClient(binding.deployment, process.env.FORGE_AUTH_TOKEN) : undefined;
  const run = async (operationId: string, apply = false, expectedPlan?: string) => {
    try {
      return await continueLongAction('Hosted check-log cleanup', operationId, async () =>
        JSON.parse(
          (await client!.action(makeFunctionReference<'action'>('projectCheckLogCleanup:clean'), {
            projectId: binding!.projectId,
            operationId,
            apply,
            ...(expectedPlan ? { expectedPlan } : {}),
          })) as string,
        ),
      );
    } catch (error) {
      if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
        const data = error.data as { code?: unknown; message?: unknown };
        if (typeof data.code === 'string' && typeof data.message === 'string')
          throw new ForgeError(data.code, data.message);
      }
      if (error instanceof ForgeError) throw error;
      throw new ForgeError(
        'HOSTED_CLEANUP_INTERRUPTED',
        `Hosted check-log cleanup: ${error instanceof Error && error.message ? error.message : 'The server returned an error without a diagnostic message.'} Resume with the same --plan file.`,
      );
    }
  };
  const review = async (operationId: string, summary: Record<string, unknown>) => {
    const result: Record<string, unknown> = { ...summary };
    for (const part of ['logs', 'shared', 'archives', 'hostedOutputs', 'digests']) {
      const rows: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page = JSON.parse(
          (await client!.query(makeFunctionReference<'query'>('projectCheckLogCleanupStore:review'), {
            projectId: binding!.projectId,
            operationId,
            planDigest: summary.planDigest,
            part,
            cursor,
          })) as string,
        );
        for (const row of page.page) rows.push(...JSON.parse(row.value));
        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor);
      result[part] = rows;
    }
    return result;
  };
  const local = localCheckLogPlan(store, Date.now(), true);
  if (!apply) {
    const path = resolve(planPath);
    const plan = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : {
          schema: 1,
          root: store.root,
          operationId: randomUUID(),
          local,
          status: 'planning',
          ...(binding ? { binding } : {}),
        };
    invariant(
      plan.root === store.root && JSON.stringify(plan.binding) === JSON.stringify(binding),
      'WORK_OPERATION_CHANGED',
      'Resume this plan with the original ROOT and hosted binding.',
    );
    if (plan.status === 'reviewed') return { ...plan, dryRun: true, planPath: path };
    invariant(
      plan.status === 'planning',
      'EVIDENCE_CHANGED',
      'This plan is already reviewed. Use --apply or choose a new plan file.',
    );
    // Keep the UUID even if the very first action reply is lost.
    if (!existsSync(path))
      writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (binding) plan.hosted = await review(plan.operationId, await run(plan.operationId));
    plan.status = 'reviewed';
    durableReplace(path, JSON.stringify(plan, null, 2) + '\n');
    return { ...plan, dryRun: true, planPath: path };
  }
  invariant(existsSync(planPath), 'BAD_ARGUMENT', 'Run --dry-run with this --plan file before applying.');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  invariant(
    plan.schema === 1 &&
      plan.status !== 'planning' &&
      plan.root === store.root &&
      JSON.stringify(plan.binding) === JSON.stringify(binding),
    'WORK_OPERATION_CHANGED',
    'Use this owner and the original hosted selection from the dry-run plan.',
  );
  const remaining = new Map(local.files.map(file => [file.path, file]));
  invariant(
    plan.local.files.every(
      (file: { path: string; sha256: string }) =>
        !remaining.has(file.path) || remaining.get(file.path)?.sha256 === file.sha256,
    ) &&
      local.files.every(file =>
        plan.local.files.some(
          (prior: { path: string; sha256: string }) =>
            prior.path === file.path && prior.sha256 === file.sha256,
        ),
      ),
    'EVIDENCE_CHANGED',
    'Local log cleanup scope changed; retain this receipt and prepare a fresh dry-run.',
  );
  // Native archive conversion keeps original manifest/Work/source bytes, while
  // omitting provider-held/expired log payloads. Its existing receipt retires the container.
  if (binding && client) {
    for (const archive of plan.hosted.archives) {
      const current = JSON.parse(
        (await client.query(makeFunctionReference<'query'>('projectCheckLogCleanupStore:archive'), {
          projectId: binding.projectId,
          backupId: archive.backupId,
        })) as string,
      );
      if (current.transport === 'objects') {
        invariant(
          current.originalDigest === archive.digest && current.manifest && current.operationId,
          'WORK_OPERATION_CHANGED',
          'Archive cleanup selected a different original receipt.',
        );
        await client.action(makeFunctionReference<'action'>('projectExchangeMigration:migrate'), {
          backupId: archive.backupId,
          operationId: current.operationId,
          originalDigest: archive.digest,
          manifestDigest: current.manifest.digest,
          manifestSize: current.manifest.size,
        });
        continue;
      }

      const directory = mkdtempSync(join(tmpdir(), 'forge-check-log-migration-'));
      try {
        const path = join(directory, 'original.tar.gz');
        const signed = await client.mutation(makeFunctionReference<'mutation'>('backupTransfer:sign'), {
          id: archive.backupId,
          digest: archive.digest,
        });
        await downloadArchiveFile(
          { sha256: archive.digest, size: archive.size },
          path,
          async offset =>
            signed ??
            ((await client.action(makeFunctionReference<'action'>('projectBackupActions:downloadPart'), {
              id: archive.backupId,
              digest: archive.digest,
              offset,
            })) as Promise<ArchivePart>),
        );
        const operation = createHash('sha256').update(`${plan.operationId}:${archive.backupId}`).digest();
        operation[6] = (operation[6]! & 15) | 80;
        operation[8] = (operation[8]! & 63) | 128;
        const hex = operation.toString('hex');
        const migrationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
        await migrateNativeArchive(
          path,
          archive.digest,
          new ConvexExchange(
            binding.deployment,
            process.env.FORGE_AUTH_TOKEN,
            binding.projectId,
            migrationId,
            null,
          ),
          archive.backupId,
          migrationId,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    if (plan.hosted.archives.length) {
      // Conversion changes the source guard. Retain the original reviewed
      // receipt and a separately resumable post-conversion plan operation.
      if (!plan.migrationCleanupId) {
        plan.migrationCleanupId = randomUUID();
        durableReplace(resolve(planPath), JSON.stringify(plan, null, 2) + '\n');
      }
      const current = await review(plan.migrationCleanupId, await run(plan.migrationCleanupId));
      invariant(
        digest(JSON.stringify(current.logs)) === digest(JSON.stringify(plan.hosted.logs)),
        'WORK_STALE',
        'Hosted log paths changed during archive conversion.',
      );
      plan.hosted = current;
      durableReplace(resolve(planPath), JSON.stringify(plan, null, 2) + '\n');
    }
  }
  const remote = binding
    ? await run(plan.migrationCleanupId ?? plan.operationId, true, plan.hosted.planDigest)
    : undefined;
  return {
    operationId: plan.operationId,
    local: cleanLocalCheckLogs(store, { apply: true, providers: true, files: plan.local.files }),
    ...(remote ? { hosted: remote } : {}),
    sourceAndResults: 'preserved',
    providerLogs: 'held by provider',
    planPath: resolve(planPath),
  };
}
