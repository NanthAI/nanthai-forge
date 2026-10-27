// SPDX-License-Identifier: Apache-2.0
import { unlinkSync } from 'node:fs';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { githubInput } from './github.js';
import { exportChannelBundle } from './work-channel.js';
import { executionGuard, workGit } from './work-git.js';
import { workGithubApi, withGithubTransport } from './work-github.js';
import type { WorkStore } from './work-store.js';
import type { MirrorCommand } from './work-types.js';

function workGitRef(store: WorkStore, branch: string) {
  workGit(store.root, ['check-ref-format', `refs/heads/${branch}`]);
}

export async function mirrorWork(store: WorkStore, command: MirrorCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  const previous = store.locked(() => {
    executionGuard(store.root);
    const data = store.load();
    if (command.action === 'check-mirror') {
      const found = data.mirrors.find(item => item.id === command.id);
      invariant(found, 'NOT_FOUND', 'Select an existing accepted-source mirror.');
      return found;
    }
    return data.mirrors.find(item => item.id === command.operationId);
  });
  const selected = githubInput(
    command.action === 'mirror-channel' ? command.repository : previous!.repository,
  );
  invariant(
    !selected.ref && selected.repository.split('/').every(part => part !== '.' && part !== '..'),
    'BAD_REPOSITORY',
    'Select an existing GitHub repository without a ref suffix.',
  );
  const repo = await workGithubApi<{ id: number; full_name: string; permissions?: { push?: boolean } }>(
    store,
    `repos/${selected.repository}`,
  );
  invariant(
    Number.isSafeInteger(repo.id) &&
      repo.id > 0 &&
      typeof repo.full_name === 'string' &&
      repo.full_name.toLowerCase() === selected.repository.toLowerCase(),
    'MIRROR_CHANGED',
    'GitHub returned another repository identity. Original source and mappings are preserved.',
  );
  if (command.action === 'mirror-channel')
    invariant(
      repo.permissions?.push === true,
      'GITHUB_WRITE_DENIED',
      'Current local GitHub access does not grant writes to this repository.',
    );
  const { mirror, sequence } = store.locked(() => {
    executionGuard(store.root);
    const data = store.load();
    let mirror = data.mirrors.find(
      item => item.id === (command.action === 'mirror-channel' ? command.operationId : command.id),
    );
    if (command.action === 'mirror-channel') {
      if (command.destination) workGitRef(store, command.destination.branch);
      const request = digest(
        JSON.stringify({
          acceptanceId: command.acceptanceId,
          expectedHead: command.expectedHead,
          repositoryId: repo.id,
          ...(command.destination ? { destination: command.destination } : {}),
        }),
      );
      if (mirror)
        invariant(
          mirror.request === request,
          'MIRROR_CHANGED',
          'This mirror operation has another source or destination. Reconcile its original inputs.',
        );
      else {
        invariant(
          data.revision === revision,
          'WORK_STALE',
          'Work changed. Refresh before mirroring; no branch was written.',
        );
        const acceptance = data.channelMoves.find(item => item.id === command.acceptanceId);
        invariant(
          acceptance?.status === 'accepted' && acceptance.head === command.expectedHead,
          'NOT_FOUND',
          'Select an original accepted Channel and its exact commit.',
        );
        mirror = {
          id: command.operationId,
          request,
          acceptance,
          repository: repo.full_name,
          repositoryId: repo.id,
          ref: `refs/heads/${command.destination?.branch ?? `forge/mirror/${command.operationId}`}`,
          at: new Date().toISOString(),
          observationSequence: 0,
          ...(command.destination ? { destination: command.destination } : {}),
        };
        data.mirrors.push(mirror);
      }
    }
    invariant(
      mirror && mirror.repositoryId === repo.id,
      'MIRROR_CHANGED',
      'The original destination repository is unavailable or was replaced. Existing source and mirror are preserved.',
    );
    mirror.observationSequence++;
    data.revision++;
    store.save(data);
    return { mirror: structuredClone(mirror), sequence: mirror.observationSequence };
  });
  return withGithubTransport(store, async (_transport, git) => {
    const remote = `https://github.com/${mirror.repository}.git`;
    const observe = async () => {
      const result = (await git(['ls-remote', '--refs', remote, mirror.ref])).trim();
      if (!result) return null;
      const parts = result.split(/\s+/);
      invariant(
        parts.length === 2 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parts[0]!) && parts[1] === mirror.ref,
        'MIRROR_CHANGED',
        'Git returned an invalid original mirror mapping.',
      );
      return parts[0]!;
    };
    let head = await observe();
    let diagnostic: 'lease-changed' | 'non-fast-forward' | undefined;
    const expected = mirror.destination?.previous ?? null;
    let writable = head === expected;
    if (mirror.destination && head !== mirror.acceptance.head) {
      if (!writable) diagnostic = 'lease-changed';
      else if (expected && command.action === 'mirror-channel' && !mirror.confirmedAt) {
        await git([
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          remote,
          `${mirror.ref}:refs/heads/mirror-destination`,
        ]);
        const fetched = (
          await git(['rev-parse', '--verify', 'refs/heads/mirror-destination^{commit}'])
        ).trim();
        if (fetched !== expected) {
          writable = false;
          diagnostic = 'lease-changed';
        } else {
          // Compatibility branches advance by ancestry; the lease never authorizes shared-history replacement.
          let ancestor: string | undefined;
          try {
            ancestor = (await git(['merge-base', expected, mirror.acceptance.head])).trim();
          } catch {
            /* Unrelated history cannot fast-forward. */
          }
          if (ancestor !== expected) {
            writable = false;
            diagnostic = 'non-fast-forward';
          }
        }
      }
    }
    if (command.action === 'mirror-channel' && !mirror.confirmedAt && writable) {
      const { result: bundle } = await exportChannelBundle(store, mirror.acceptance.id);
      try {
        invariant(
          bundle.head === mirror.acceptance.head,
          'MIRROR_CHANGED',
          'The retained source receipt changed. Nothing was pushed.',
        );
        // Exact native lease protects concurrent retries and unrelated remote work.
        try {
          await git([
            'push',
            '--porcelain',
            `--force-with-lease=${mirror.ref}:${expected ?? ''}`,
            remote,
            `${bundle.head}:${mirror.ref}`,
          ]);
        } catch {
          /* Reconcile the native remote after an unknown push outcome; never overwrite another head. */
        }
      } finally {
        unlinkSync(bundle.path);
      }
      head = await observe();
    }
    return store.locked(() => {
      const data = store.load(),
        saved = data.mirrors.find(item => item.id === mirror.id);
      invariant(
        saved?.request === mirror.request && saved.repositoryId === repo.id,
        'MIRROR_CHANGED',
        'Mirror metadata changed; original Git work is preserved.',
      );
      const at = new Date().toISOString();
      if (head === mirror.acceptance.head && !saved.confirmedAt) saved.confirmedAt = at;
      if (saved.observationSequence === sequence) {
        saved.observation = {
          at,
          head,
          status: head === null ? 'missing' : head === mirror.acceptance.head ? 'matching' : 'diverged',
        };
        if (saved.destination) {
          if (head === mirror.acceptance.head) delete saved.diagnostic;
          else saved.diagnostic = diagnostic ?? (head === expected ? saved.diagnostic : 'lease-changed');
        }
      }
      data.revision++;
      store.save(data);
      return { revision: data.revision, result: saved };
    });
  });
}
