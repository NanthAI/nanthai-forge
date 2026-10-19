// SPDX-License-Identifier: Apache-2.0
import { existsSync, linkSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { fingerprintPrivateFile } from './files.js';
import { captureArtifacts } from './work-artifacts.js';
import { executionGuard, materializeLane, workGit } from './work-git.js';
import { withGithubTransport } from './work-github.js';
import type { WorkStore } from './work-store.js';
import type { ContributionCommand, Lane } from './work-types.js';

export async function importBundle(store: WorkStore, command: ContributionCommand, revision: number) {
  invariant(
    Number.isSafeInteger(revision) && revision >= 0 && isAbsolute(command.path),
    'BAD_ARGUMENT',
    'Choose an absolute local bundle path and valid observed Work revision.',
  );
  workGit(store.root, ['check-ref-format', command.ref]);
  invariant(
    command.ref.startsWith('refs/heads/'),
    'BAD_ARGUMENT',
    'Select a named source branch from the full bundle.',
  );
  const request = digest(JSON.stringify(command)),
    retained = join(store.directory, `contribution-${command.operationId}.bundle`);
  const reconcile = (lane: Lane) => {
    invariant(
      lane.contribution?.request === request,
      'WORK_OPERATION_CHANGED',
      'Reconcile this contribution’s original bundle, source pins and Lane name.',
    );
    if (lane.state === 'creating') {
      materializeLane(store.root, store.path(lane.id), lane);
      lane.state = 'active';
    }
    return lane;
  };
  const original = store.locked(() => {
    executionGuard(store.root);
    const data = store.load(),
      old = data.lanes.find(lane => lane.id === command.operationId);
    if (old) {
      const creating = old.state === 'creating',
        result = reconcile(old);
      if (creating) {
        data.revision++;
        store.save(data);
      }
      return { revision: data.revision, result };
    }
    invariant(
      data.revision === revision,
      'WORK_STALE',
      'Work changed. Refresh before importing; existing source is preserved.',
    );
    invariant(
      data.intents.find(item => item.id === command.intentId)?.base === command.expectedBase,
      'CONTRIBUTION_CHANGED',
      'Select the original Intent base for this contribution.',
    );

    return undefined;
  });
  if (original) return original;
  return withGithubTransport(
    store,
    async (path, _git, retain) => {
      if (!existsSync(retained)) {
        const [file] = await captureArtifacts(realpathSync(dirname(command.path)), path, [
          basename(command.path),
        ]);
        invariant(
          file?.status === 'retained' && file.sha256 === command.sha256,
          'INVALID_CONTRIBUTION',
          'The original full bundle could not be copied with its selected digest. Existing source is preserved.',
        );
        const copy = join(path, 'artifacts', file.filename);
        try {
          linkSync(copy, retained);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        unlinkSync(copy);
      }
      const file = await fingerprintPrivateFile(retained, 'INVALID_CONTRIBUTION');
      invariant(
        file.sha256 === command.sha256,
        'INVALID_CONTRIBUTION',
        'The retained bundle differs from this contribution’s original digest.',
      );
      // Native bundle verification without alternates requires complete original history, not a filtered projection.
      unlinkSync(join(path, 'objects/info/alternates'));
      workGit(path, ['--no-lazy-fetch', '--no-replace-objects', 'bundle', 'verify', retained]);
      const heads = workGit(path, ['bundle', 'list-heads', retained]).trim().split('\n');
      invariant(
        heads.includes(`${command.expectedHead} ${command.ref}`),
        'CONTRIBUTION_CHANGED',
        'The selected bundle branch names another source commit.',
      );
      workGit(path, ['--no-lazy-fetch', '--no-replace-objects', 'bundle', 'unbundle', retained]);
      workGit(path, ['update-ref', 'refs/heads/contribution', command.expectedHead]);
      workGit(path, [
        '--no-lazy-fetch',
        '--no-replace-objects',
        'fsck',
        '--connectivity-only',
        '--no-reflogs',
      ]);
      invariant(
        workGit(path, [
          '--no-replace-objects',
          'merge-base',
          command.expectedBase,
          command.expectedHead,
        ]).trim() === command.expectedBase,
        'CONTRIBUTION_CHANGED',
        'The full contribution does not descend from the selected Intent base. No Lane or Channel changed.',
      );
      return store.locked(() => {
        executionGuard(store.root);
        const data = store.load(),
          old = data.lanes.find(lane => lane.id === command.operationId);
        if (old) {
          const creating = old.state === 'creating',
            result = reconcile(old);
          if (creating) {
            data.revision++;
            store.save(data);
          }
          return { revision: data.revision, result };
        }
        invariant(
          data.revision === revision,
          'WORK_STALE',
          'Work changed during bundle validation. Original bytes are retained; refresh before importing.',
        );
        invariant(
          data.intents.find(item => item.id === command.intentId)?.base === command.expectedBase,
          'CONTRIBUTION_CHANGED',
          'The Intent base changed during validation.',
        );

        retain([command.expectedHead]);
        const lane: Lane = {
          id: command.operationId,
          intentId: command.intentId,
          name: command.name,
          assignment: '',
          target: '',
          base: command.expectedHead,
          head: command.expectedHead,
          state: 'creating',
          checkpoints: [],
          contribution: {
            request,
            head: command.expectedHead,
            base: command.expectedBase,
            ref: command.ref,
            ...file,
            at: new Date().toISOString(),
            provenance: 'unverified-git-bundle',
          },
        };
        data.lanes.push(lane);
        data.revision++;
        store.save(data); // Journal before creating a worktree; never replace an unknown partial workspace.
        reconcile(lane);
        data.revision++;
        store.save(data);
        return { revision: data.revision, result: lane };
      });
    },
    'contributions',
  );
}
