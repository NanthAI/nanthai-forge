// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportNativeGit } from './native-git.js';
import { retainedAcceptance } from './work-channel.js';
import { fullGitBundle } from './work-git-bundle.js';
import { workGit } from './work-git.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

/** A request-private Git projection; native source and original Work remain authoritative. */
export async function nativeChannelGit(
  store: WorkStore,
  data: WorkData,
  id: string,
  history: boolean,
  directory: string,
) {
  const move = data.channelMoves.find(item => item.id === id);
  invariant(
    move?.status === 'accepted' && retainedAcceptance(store, data, move),
    'NOT_FOUND',
    'Select a retained native Channel acceptance and its original clean Candidate/source.',
  );
  const moves = history
    ? data.channelMoves.filter(item => item.channel === move.channel && item.status === 'accepted')
    : [move];
  for (const item of moves)
    invariant(
      retainedAcceptance(store, data, item),
      'INVALID_CHANNEL_EXPORT',
      'A retained native Channel acceptance changed. Original source and immutable URLs remain available.',
    );

  const projections = new Map<string, string>();
  let repository: string | undefined, format: string | undefined;
  for (const head of [...new Set([move.head, ...moves.map(item => item.head)])]) {
    const exported = await exportNativeGit(
      store.root,
      head,
      join(directory, `projection-${projections.size}`),
    );
    invariant(
      !format || exported.format === format,
      'UNSUPPORTED_NATIVE_GIT_FORMAT',
      'Retained Channel source uses different original Git object formats. Native source remains available.',
    );
    format = exported.format;
    if (!repository) repository = join(exported.path, 'repository.git');
    else workGit(repository, ['--no-lazy-fetch', 'bundle', 'unbundle', exported.bundle.path]);
    projections.set(head, exported.commit);
  }
  invariant(repository, 'INVALID_CHANNEL_EXPORT', 'The selected native projection is unavailable.');
  const refs = [
    { ref: 'refs/heads/accepted', head: projections.get(move.head)! },
    ...(history
      ? moves.map(item => ({ ref: `refs/heads/acceptances/${item.id}`, head: projections.get(item.head)! }))
      : []),
  ];
  // Original imported refs/objects stay private in the intermediate projection. Only selected
  // accepted refs and reachable ancestry enter the final self-contained served repository.
  writeFileSync(join(repository, 'objects/info/alternates'), '', { flag: 'wx', mode: 0o600 });
  const bundle = join(directory, 'accepted.bundle');
  await fullGitBundle(repository, refs, bundle, 'INVALID_CHANNEL_EXPORT');
  return bundle;
}
