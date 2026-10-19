// SPDX-License-Identifier: Apache-2.0
import { ForgeError, invariant } from './errors.js';
import { evidenceView } from './work-evidence.js';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import type { InteractionCommand, WorkView } from './work-types.js';
import type { WorkStore } from './work-store.js';

function changedPaths(root: string, view: WorkView, native = false) {
  try {
    if (native) {
      const source = new NativeSource(root),
        before = new Map(source.state(view.base).files.map(f => [f.path, f])),
        after = new Map(source.state(view.head!).files.map(f => [f.path, f]));
      const paths = new Map<string, Buffer>();
      for (const path of new Set([...before.keys(), ...after.keys()]))
        if (
          before.get(path)?.blob !== after.get(path)?.blob ||
          before.get(path)?.mode !== after.get(path)?.mode
        ) {
          const bytes = Buffer.from(path);
          paths.set(bytes.toString('base64'), bytes);
        }
      return { paths, diagnostic: null };
    }
    const output = workGit(
      root,
      [
        '--no-lazy-fetch',
        '--no-replace-objects',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--ignore-submodules=none',
        '--no-relative',
        '--name-only',
        '-z',
        view.base,
        view.head!,
        '--',
      ],
      undefined,
      false,
      true,
    );
    invariant(
      !output.length || output.at(-1) === 0,
      'INVALID_INTERACTION',
      'Changed-path output is incomplete. Coverage is unknown.',
    );
    const paths = new Map<string, Buffer>();
    let start = 0;
    for (let end = output.indexOf(0); end >= 0; end = output.indexOf(0, start)) {
      const path = output.subarray(start, end);
      invariant(
        path.length > 0,
        'INVALID_INTERACTION',
        'Changed-path output is invalid. Coverage is unknown.',
      );
      paths.set(path.toString('base64'), path);
      start = end + 1;
    }
    return { paths, diagnostic: null };
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    return { paths: null, diagnostic: { code: error.code, message: error.message } };
  }
}
function pathFact(bytes: Buffer) {
  let display: string,
    displayEncoding = 'UTF-8';
  try {
    display = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    display = bytes.toString('utf8');
    displayEncoding = 'UTF-8 replacement; original path bytes retained';
  }
  return { display, displayEncoding, rawBase64: bytes.toString('base64') };
}

export function compareViews(store: WorkStore, command: InteractionCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  const data = store.load(),
    left = evidenceView(data, command.viewId, command.expectedHead),
    right = evidenceView(data, command.otherViewId, command.otherHead);
  const first = changedPaths(store.root, left, store.native),
    second = changedPaths(store.root, right, store.native);
  const common =
    first.paths && second.paths
      ? [...first.paths.values()]
          .filter(path => second.paths!.has(path.toString('base64')))
          .sort(Buffer.compare)
      : null;
  const snapshot = (view: WorkView, observed: ReturnType<typeof changedPaths>) => ({
    viewId: view.id,
    intentId: view.intentId,
    head: view.head!,
    base: view.base,
    inputs: view.inputs,
    dependencies: view.dependencies ?? [],
    changedPathCount: observed.paths?.size ?? null,
    diagnostic: observed.diagnostic,
  });
  const next = command.offset + command.limit;
  return {
    revision: data.revision,
    result: {
      schema: 1,
      kind: 'local-view-interaction' as const,
      private: true,
      observedAt: new Date().toISOString(),
      left: snapshot(left, first),
      right: snapshot(right, second),
      differentBases: left.base !== right.base,
      status: common ? ('observed' as const) : ('incomplete' as const),
      commonPathCount: common?.length ?? null,
      offset: command.offset,
      limit: command.limit,
      nextOffset: common && next < common.length ? next : null,
      sharedPaths: common?.slice(command.offset, next).map(pathFact) ?? [],
      provenance: store.native
        ? 'Original retained native State manifests; exact changed path/blob/mode intersection against each View’s own base.'
        : 'Original retained View/head/base/input/dependency pins; exact local Git changed-path byte intersection against each View’s own base.',
      coverage:
        'Committed path changes only, including original and new paths for renames. Distinct bases are separate comparisons. Uncommitted work, runtime/contract dependencies and conflict/independence are unknown. No fetch, execution, validation reuse or publication decision.',
    },
  };
}
export type ViewInteraction = ReturnType<typeof compareViews>['result'];
