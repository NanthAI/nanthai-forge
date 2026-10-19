// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { WorkStore } from './work-store.js';
import { NativeSource, nativeOwner, type NativeFile } from './native-source.js';
import { nativeChanges, nativeDiff } from './native-diff.js';
import { branchFor, executionGuard, headAt, workGit } from './work-git.js';
import { validateNativePr } from './native-pr-pins.js';
import { ForgeError, invariant } from './errors.js';
import { detailCommandSchema, type Lane, type WorkView } from './work-types.js';

export function viewReview(store: WorkStore, view: WorkView, compact = false) {
  if (compact) return { ...view, details: '', detailDeferred: true };
  const source = store.native ? new NativeSource(store.root) : null;
  const details =
    source && view.status === 'clean' && view.head
      ? nativeDiff(source, source.state(view.base).files, source.state(view.head).files)
      : !source && view.status === 'clean' && view.head && !view.details
        ? workGit(store.root, ['diff', '--no-ext-diff', '--no-textconv', view.base, view.head, '--'])
        : view.details;
  return { ...view, details };
}

export function laneReview(store: WorkStore, lane: Lane, compact = false) {
  const path = store.path(lane.id);
  if (store.native) {
    // Overview reports retained pins and directory availability. Current owner and
    // live source are verified by the existing selected detail/mutation boundary.
    // Reading every historical marker/source here can block on cloud hydration.
    if (compact) {
      const available =
        existsSync(path) &&
        lstatSync(path).isDirectory() &&
        !lstatSync(path).isSymbolicLink() &&
        realpathSync(path) === path &&
        lane.state !== 'creating';
      return {
        ...lane,
        path,
        available,
        actualHead: available ? lane.head : null,
        indexTree: null,
        changes: '',
        staged: '',
        diff: '',
        detailDeferred: true,
        captureCoverage: lane.checkpoints.at(-1)?.captureCoverage,
      };
    }
    const source = new NativeSource(store.root);
    const available = existsSync(path) && nativeOwner(path) === store.root && lane.state !== 'creating';
    let files: NativeFile[] = [],
      captureCoverage;
    if (available)
      try {
        const capture = source.captureReport(path, false, lane.head);
        files = capture.files;
        captureCoverage = capture.coverage;
      } catch (error) {
        if (
          !(error instanceof ForgeError && error.code === 'SOURCE_CHANGED') &&
          !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        const diagnostic =
          'Preview unavailable: live Lane source changed while capturing. Refresh to review its current bytes.';
        return {
          ...lane,
          path,
          available,
          actualHead: lane.head,
          indexTree: null,
          changes: diagnostic,
          staged: diagnostic,
          diff: compact ? '' : diagnostic,
          ...(compact ? { detailDeferred: true } : {}),
        };
      }
    const changes = available ? nativeChanges(source.state(lane.head).files, files) : '';
    return {
      ...lane,
      path,
      available,
      actualHead: available ? lane.head : null,
      indexTree: available ? source.tree(files) : null,
      captureCoverage,
      changes,
      staged: changes,
      diff: !compact && available ? nativeDiff(source, source.state(lane.base).files, files, path) : '',
      ...(compact ? { detailDeferred: true } : {}),
    };
  }
  if (lane.state === 'creating')
    return {
      ...lane,
      path,
      available: false,
      changes: '',
      staged: '',
      diff: '',
      indexTree: null,
      actualHead: null,
      ...(compact ? { detailDeferred: true } : {}),
    };
  invariant(
    existsSync(path) && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
    'LANE_UNAVAILABLE',
    'Lane workspace is unavailable or unsafe. Existing work has not been removed.',
  );
  executionGuard(path);
  invariant(
    workGit(path, ['symbolic-ref', 'HEAD']).trim() === branchFor(lane.id),
    'LANE_BRANCH_CHANGED',
    'Lane is checked out on another branch. Restore its Forge branch before continuing.',
  );
  return {
    ...lane,
    path,
    available: true,
    actualHead: headAt(path),
    indexTree: workGit(path, ['write-tree']).trim(),
    changes: workGit(path, ['status', '--short', '--untracked-files=normal']),
    staged: workGit(path, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat']),
    diff: compact ? '' : workGit(path, ['diff', '--no-ext-diff', '--no-textconv', lane.base, '--']),
    ...(compact ? { detailDeferred: true } : {}),
  };
}

export function readWorkDetail(store: WorkStore, input: unknown) {
  const parsed = detailCommandSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Select a retained review and its original source pins.');
  return store.locked(() => {
    const data = store.load(),
      command = parsed.data;
    if (command.kind === 'lane') {
      const lane = data.lanes.find(item => item.id === command.id);
      invariant(lane, 'NOT_FOUND', 'Lane not found.');
      const detail = laneReview(store, lane);
      invariant(
        detail.available,
        'LANE_UNAVAILABLE',
        'The selected Lane workspace or its original owner marker is unavailable. Existing source is retained.',
      );
      invariant(
        detail.actualHead === command.expectedHead,
        'LANE_STALE',
        'Lane source changed. Refresh to review its current head.',
      );
      return { revision: data.revision, result: { kind: 'lane' as const, lane: detail } };
    }
    if (command.kind === 'view') {
      const view = data.views.find(item => item.id === command.id);
      invariant(view, 'NOT_FOUND', 'View not found.');
      invariant(
        view.head === command.expectedHead &&
          view.base === command.expectedBase &&
          view.status === command.expectedStatus,
        'VIEW_STALE',
        'Select this View’s original source pins.',
      );
      return { revision: data.revision, result: { kind: 'view' as const, view: viewReview(store, view) } };
    }
    const intent = data.intents.find(item => item.id === command.id),
      observation = intent?.external?.observations[command.observation];
    invariant(intent && observation, 'NOT_FOUND', 'External source observation not found.');
    invariant(
      observation.head === command.expectedHead && observation.base === command.expectedBase,
      'VIEW_STALE',
      'Select the original external source observation.',
    );
    if (store.native) {
      const source = new NativeSource(store.root),
        pins = validateNativePr(source, observation);
      return {
        revision: data.revision,
        result: {
          kind: 'external' as const,
          intentId: intent.id,
          observation: command.observation,
          head: observation.head,
          base: observation.base,
          native: pins,
          details: nativeDiff(source, source.state(pins.base).files, source.state(pins.head).files),
        },
      };
    }
    return {
      revision: data.revision,
      result: {
        kind: 'external' as const,
        intentId: intent.id,
        observation: command.observation,
        head: observation.head,
        base: observation.base,
        details: workGit(store.root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          observation.base,
          observation.head,
          '--',
        ]),
      },
    };
  });
}
