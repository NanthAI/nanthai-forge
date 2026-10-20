// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import { checkChangedPaths } from './work-check-scope.js';
import { checkEnvironment } from './check-environment.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';

const quote = (value: string) =>
  /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** Preview the scoped selector on saved bytes, without running repository code or taking a lock. */
export async function agentLaneTests(store: WorkStore, laneId: string) {
  const tx = store.readRecords(),
    data = tx ? tx.data() : store.load(),
    lane = tx ? tx.fields('lanes', laneId)?.record : data.lanes.find(item => item.id === laneId);
  invariant(lane, 'NOT_FOUND', 'Lane not found.');
  const moves = tx ? tx.all('channelMoves', 'main', 'channel') : data.channelMoves;
  const main = store.native
    ? (moves
        .slice()
        .reverse()
        .find(move => move.channel === 'main' && move.status === 'accepted')?.head ?? data.nativeHead)
    : workGit(
        store.root,
        ['rev-parse', '--verify', '--quiet', 'refs/forge/channels/main'],
        undefined,
        true,
      ).trim() || lane.base;
  invariant(main, 'NOT_FOUND', 'Main source not found.');
  const { standardSelection, selectionSourcePath } = await import('../scripts/test-impact.mjs');
  const files = new Map<string, string>();
  if (store.native) {
    const source = new NativeSource(store.root);
    for (const file of source.state(lane.head).files)
      if (selectionSourcePath(file.path)) files.set(file.path, source.object(file.blob).toString('utf8'));
  } else {
    const tree = workGit(store.root, ['ls-tree', '-r', '-z', lane.head]);
    for (const row of tree.split('\0').filter(Boolean)) {
      const split = row.indexOf('\t'),
        [, kind, blob] = row.slice(0, split).split(' '),
        path = row.slice(split + 1);
      if (kind === 'blob' && selectionSourcePath(path))
        files.set(
          path,
          workGit(store.root, ['cat-file', 'blob', blob!], undefined, false, true).toString('utf8'),
        );
    }
  }
  const { scope, reason, tests } = standardSelection({
    files,
    paths: checkChangedPaths(store, main, lane.head),
    env: { ...checkEnvironment().env, FORGE_CHECK_SCOPED: '1' },
  });
  return {
    revision: data.revision,
    result: {
      scope,
      reason,
      tests,
      command: tests.length
        ? `node --import ./tests/check-runtime.mjs --test ${tests.map(quote).join(' ')}`
        : null,
      laneId,
      head: lane.head,
      main,
    },
  };
}
