// SPDX-License-Identifier: Apache-2.0
import { workProgress } from './work-progress.js';
import { requestPushAudit } from './pre-push-audit.js';
import { drainPostAccept } from './post-accept-main.js';
import { sourceExclusion } from './files.js';
import { isGreenMain } from './github-auto-push-state.js';
import { publishGithubStatus } from './github-sync-status.js';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkStore } from './work-store.js';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import { invariant } from './errors.js';
import { changed, githubReconciliation, reconciliationDetail } from './github-sync-reconcile.js';
import { githubHistoryContainment } from './github-sync-history.js';
import {
  remoteSyncHead,
  syncGit,
  retrySyncGit,
  syncIdentity,
  withSyncGit,
  defaultSyncRepository,
} from './github-sync-git.js';
import { appendCommits, restorePending, commitPlan } from './github-sync-plan.js';

const same = isDeepStrictEqual;
export async function githubSync(
  input: string,
  options: {
    repository?: string;
    branch?: string;
    push?: boolean;
    operationId?: string;
    autoPush?: boolean;
    rebind?: boolean;
  } = {},
) {
  const store = new WorkStore(input);
  invariant(store.native, 'BAD_ARGUMENT', 'github-sync requires a native Forge owner or Lane.');
  const source = new NativeSource(store.root),
    snapshot = store.observing(() => ({ data: store.load(), records: store.readRecords() })),
    { data } = snapshot,
    stored = data.githubSync,
    // A rebind starts a fresh binding; the stored one is kept as history, never reused.
    original = options.rebind ? undefined : stored;
  if (options.rebind) {
    invariant(options.repository, 'BAD_ARGUMENT', '--rebind needs --repo OWNER/NAME.');
    invariant(stored, 'GITHUB_SYNC_REBIND', 'This owner has no GitHub binding to replace.');
    invariant(
      stored.pushed === stored.commits.length,
      'GITHUB_SYNC_PENDING',
      'The current binding has an unfinished operation. Reconcile it with github-sync --push before --rebind.',
    );
    invariant(
      stored.repository.toLowerCase() !== options.repository.toLowerCase() ||
        stored.branch !== (options.branch ?? stored.branch),
      'GITHUB_SYNC_REBIND',
      'The owner is already bound to this repository and branch.',
    );
  }
  if (options.autoPush)
    invariant(isGreenMain(data), 'GITHUB_SYNC_CHECK_PENDING', 'Current main has no passing check.');
  return withSyncGit(store.directory, async root => {
    const repository = options.repository ?? original?.repository ?? (await defaultSyncRepository(input));
    invariant(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
        repository.split('/').every(part => part !== '.' && part !== '..'),
      'BAD_REPOSITORY',
      'Use --repo OWNER/NAME.',
    );
    const branch = options.branch ?? original?.branch ?? 'main',
      ref = `refs/heads/${branch}`;
    workGit(root, ['check-ref-format', ref]);
    invariant(
      !original ||
        (original.repository.toLowerCase() === repository.toLowerCase() && original.branch === branch),
      'GITHUB_SYNC_BINDING',
      'This owner is bound to another GitHub repository or branch. Existing mapping is preserved.',
    );
    if (options.operationId)
      invariant(z.uuid().safeParse(options.operationId).success, 'BAD_ARGUMENT', 'Use a UUID operation id.');
    if (options.push) {
      const audit = requestPushAudit(store);
      await drainPostAccept(store, audit);
    }
    const remote = `https://github.com/${repository}.git`;
    // A branch that does not exist yet (an empty repository) is adopted as a root commit.
    const allowMissing = !original || (original.pushed === 0 && original.adoptedCommit === '');
    let remoteHead = await remoteSyncHead(root, remote, ref, allowMissing);
    if (remoteHead)
      await syncGit(root, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        remote,
        `${ref}:refs/heads/observed`,
      ]);
    const fetchedHead = remoteHead ? workGit(root, ['rev-parse', 'refs/heads/observed']).trim() : '';
    if (fetchedHead !== remoteHead)
      throw changed({
        expectedHead: original?.commits[original.pushed - 1]?.commit ?? original?.adoptedCommit ?? remoteHead,
        remoteHead: fetchedHead,
        ...(original?.commits.at(-1) ? { localHead: original.commits.at(-1)!.commit } : {}),
      });
    const pushed = original?.pushed ?? 0,
      pending = original?.commits.slice(pushed) ?? [],
      recorded = pushed ? original!.commits[pushed - 1]!.commit : (original?.adoptedCommit ?? remoteHead);
    // Retained batches pin their own parent, including an adopted external head.
    let expected = pending[0]?.parent ?? recorded;
    const alreadyPushed = pending.length > 0 && pending.at(-1)!.commit === remoteHead;
    const repeated = options.operationId
      ? original?.commits.filter(entry => entry.operationId === options.operationId)
      : undefined;
    invariant(
      !pending.length ||
        Boolean(repeated?.length && original!.commits.indexOf(repeated.at(-1)!) < pushed) ||
        !options.operationId ||
        pending.every(entry => entry.operationId === options.operationId),
      'GITHUB_SYNC_PENDING',
      'Retry the pending operation id before starting another sync.',
    );
    let reconciliation;
    let adoption;
    if (remoteHead !== expected && !alreadyPushed) {
      const heads = {
        expectedHead: expected,
        remoteHead,
        ...(original?.commits.at(-1) ? { localHead: original.commits.at(-1)!.commit } : {}),
      };
      if (pending.length || repeated?.length) throw changed(heads);
      adoption = appendCommits(
        root,
        source,
        data,
        undefined,
        remoteHead,
        options.operationId ?? randomUUID(),
        await syncIdentity(root),
        options.autoPush,
      );
      const adopted = adoption[0]!;
      reconciliation = githubReconciliation(root, recorded, remoteHead, adopted.tree, targets =>
        githubHistoryContainment(
          root,
          source,
          snapshot,
          original?.commits[pushed - 1],
          adopted,
          targets,
          options.autoPush,
        ),
      );
      if (reconciliation.status !== 'contained')
        throw Object.assign(changed(heads, reconciliationDetail(reconciliation)), { reconciliation });
      expected = remoteHead;
    }
    const entries =
      adoption ??
      (repeated?.length
        ? repeated
        : pending.length
          ? pending
          : appendCommits(
              root,
              source,
              data,
              original,
              remoteHead,
              options.operationId ?? randomUUID(),
              await syncIdentity(root),
              options.autoPush,
            ));
    if (options.autoPush)
      invariant(
        entries.every(entry =>
          source
            .state(entry.state)
            .files.every(file => !sourceExclusion(file.path) || entry.excludedPaths?.includes(file.path)),
        ),
        'GITHUB_SYNC_PRIVATE_PENDING',
        'A retained manual batch includes private paths. Its mapping is preserved; automatic publication did not send it.',
      );
    if (pending.length || repeated?.length) restorePending(root, source, entries);
    const plan = {
      dryRun: !options.push,
      repository,
      ref,
      adoptedCommit: original?.adoptedCommit ?? remoteHead,
      remoteHead,
      alreadyPushed:
        alreadyPushed || Boolean(repeated?.length && original!.commits.indexOf(repeated.at(-1)!) < pushed),
      commits: entries.map(entry => commitPlan(root, entry)),
      pushed: false,
      ...(reconciliation ? { reconciliation } : {}),
      ...(options.rebind
        ? {
            rebind: {
              from: { repository: stored!.repository, branch: stored!.branch },
              to: { repository, branch },
              history: 'The current binding is kept in Work metadata (githubSyncHistory).',
              ...(data.autonomyPolicy?.githubMirror
                ? {
                    mirrorPolicy: `The automatic mirror policy still points at ${data.autonomyPolicy.githubMirror.repo}; rebinding does not change it. Update it with set-policy.`,
                  }
                : {}),
            },
          }
        : {}),
    };
    if (!options.push) return plan;
    if (!entries.length) return { ...plan, hostedSync: await publishGithubStatus(store) };
    const binding = original
      ? structuredClone(original)
      : { repository, branch, adoptedCommit: remoteHead, commits: [], pushed: 0 };
    if (!pending.length && !repeated?.length) {
      binding.commits.push(...entries);
      store.locked(() => {
        const current = store.load();
        invariant(
          same(current.githubSync, stored),
          'WORK_STALE',
          'Another sync changed the binding. Retry to reconcile.',
        );
        if (options.rebind)
          (current.githubSyncHistory ??= []).push({
            id: randomUUID(),
            replacedAt: new Date().toISOString(),
            binding: stored!,
          });
        current.githubSync = binding;
        current.revision++;
        store.save(current);
      });
    }
    if (!plan.alreadyPushed) {
      if (options.autoPush) {
        const policy = store.load().autonomyPolicy?.githubMirror;
        invariant(
          policy?.autoPush && policy.repo === repository,
          'GITHUB_SYNC_DISABLED',
          'Automatic mirror policy changed.',
        );
      }
      const head = entries.at(-1)!.commit;
      invariant(
        !expected || workGit(root, ['merge-base', expected, head]).trim() === expected,
        'GITHUB_SYNC_HISTORY',
        'Sync must fast-forward its exact adopted GitHub head.',
      );
      await retrySyncGit(
        async () => {
          remoteHead = await remoteSyncHead(root, remote, ref, !expected);
          if (remoteHead === head) return;
          if (remoteHead !== expected) throw changed({ expectedHead: expected, remoteHead, localHead: head });
          try {
            // An exact lease is CAS, never permission to replace history: ancestry is checked above.
            await syncGit(root, [
              'push',
              '--porcelain',
              `--force-with-lease=${ref}:${expected}`,
              remote,
              `${head}:${ref}`,
            ]);
          } catch (error) {
            remoteHead = await remoteSyncHead(root, remote, ref, !expected);
            if (remoteHead !== head) {
              if (remoteHead !== expected)
                throw changed({ expectedHead: expected, remoteHead, localHead: head });
              throw error;
            }
          }
        },
        undefined,
        message => workProgress('github-sync', message),
      );
      remoteHead = await remoteSyncHead(root, remote, ref, !expected);
      if (remoteHead !== head) throw changed({ expectedHead: expected, remoteHead, localHead: head });
    }
    store.locked(() => {
      const current = store.load(),
        saved = current.githubSync;
      invariant(
        saved && entries.every(entry => saved.commits.some(item => same(item, entry))),
        'GITHUB_SYNC_HISTORY',
        'Pending sync mapping changed. Retry the original operation.',
      );
      const end = saved.commits.findIndex(entry => entry.commit === entries.at(-1)!.commit) + 1;
      const status = current.githubAutoPush;
      const completed =
        status?.repository.toLowerCase() === repository.toLowerCase() &&
        entries.at(-1)?.acceptanceId === status.acceptanceId;
      if (completed)
        Object.assign(status!, {
          status: 'pushed',
          code: '',
          detail: '',
          nextAttemptAt: '',
          at: new Date().toISOString(),
        });
      if (saved.pushed < end || completed) {
        if (saved.pushed < end) {
          saved.pushed = end;
          saved.pushedAt = new Date().toISOString();
        }
        current.revision++;
        store.save(current);
      }
    });
    return { ...plan, pushed: true, hostedSync: await publishGithubStatus(store) };
  });
}
