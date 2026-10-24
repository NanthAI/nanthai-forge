// SPDX-License-Identifier: Apache-2.0
import { handoffSummary } from './agent-handoff-types.js';
import { readHandoff } from './agent-handoff.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { nativeFile } from './native-file.js';
import { NativeSource, nativeOwner } from './native-source.js';
import { WorkStore } from './work-store.js';
import { branchFor, executionGuard, headAt, workGit } from './work-git.js';
import { digest } from './hash.js';
import { readSource, safeRelative } from './files.js';
import { invariant } from './errors.js';
import { contextualHunks } from './review-hunks.js';

export const agentReviewSchema = z
  .object({
    kind: z.enum(['lane', 'view']),
    id: z.string().uuid(),
    expectedHead: z
      .string()
      .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
      .nullable(),
    expectedReviewTree: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    expectedBase: z
      .string()
      .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
      .optional(),
    expectedStatus: z.enum(['clean', 'conflict']).optional(),
    paths: z.array(z.string().refine(safeRelative)).max(100).optional(),
    offset: z.number().int().nonnegative().safe().default(0),
    limit: z.number().int().min(1).max(100).default(20),
    context: z.number().int().min(0).max(10).default(3),
    maxBytes: z.number().int().min(1024).max(48000).default(12000),
  })
  .strict();
export const agentStateDiffSchema = agentReviewSchema
  .pick({ paths: true, offset: true, limit: true, context: true, maxBytes: true, expectedReviewTree: true })
  .extend({
    from: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    to: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  });
export function readAgentStateDiff(store: WorkStore, input: z.input<typeof agentStateDiffSchema>) {
  return readReview(store, agentStateDiffSchema.parse(input));
}
export type AgentReviewInput = z.input<typeof agentReviewSchema>;
type File = { hash: string; hashKind: 'sha256' | 'git-object'; mode: string };
type Change = {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  before: File | null;
  after: File | null;
};
function status(before: File | null, after: File | null): Change['status'] {
  return !before ? 'added' : !after ? 'deleted' : 'modified';
}

/** Compact review is an observation, never evidence of acceptance or coverage. */
export function readAgentReview(store: WorkStore, input: AgentReviewInput) {
  return readReview(store, agentReviewSchema.parse(input));
}
function readReview(
  store: WorkStore,
  command: z.output<typeof agentReviewSchema> | z.output<typeof agentStateDiffSchema>,
) {
  const selection = 'kind' in command ? command : undefined,
    states = 'from' in command ? command : undefined;
  return store.observing(() => {
    const revision = store.revision(),
      lane = selection?.kind === 'lane' ? store.select('lanes', selection.id) : undefined;
    const view = selection?.kind === 'view' ? store.select('views', selection.id) : undefined;
    invariant(states || lane || view, 'NOT_FOUND', 'Select an existing Lane or Candidate.');
    const base = states?.from ?? (lane ?? view)!.base,
      head = states?.to ?? (lane ?? view)!.head;
    invariant(
      !selection || head === selection.expectedHead,
      'VIEW_STALE',
      'Select the original retained source head.',
    );
    if (view)
      invariant(
        base === selection?.expectedBase && view.status === selection?.expectedStatus,
        'VIEW_STALE',
        'Select the exact Candidate base and status.',
      );
    const pins = {
      ...(selection ? { kind: selection.kind, id: selection.id } : { kind: 'states' }),
      base,
      head,
      ...(lane ? { handoff: handoffSummary(readHandoff(store, lane.id).result.handoff) } : {}),
      ...(view ? { status: view.status, inputs: view.inputs, dependencies: view.dependencies ?? [] } : {}),
    };
    if (view?.status === 'conflict')
      return {
        revision,
        result: {
          ...pins,
          total: 0,
          truncated: false,
          changes: [],
          unavailable: 'Conflicted Candidate has no composed source; inspect its retained full review.',
          coverage: 'unknown',
        },
      };
    invariant(head, 'VIEW_STALE', 'The selected source head is unavailable.');
    const path = lane ? store.path(lane.id) : undefined,
      changes: Change[] = [];
    let content: (change: Change) => { before: Buffer; after: Buffer };
    let indexTree: string | undefined;
    let gitSelection: object = {};
    let untracked: string[] = [];
    const recreated = new Set<string>();
    if (store.native) {
      const source = new NativeSource(store.root),
        before = source.state(base).files;
      if (path)
        invariant(
          existsSync(path) &&
            lstatSync(path).isDirectory() &&
            !lstatSync(path).isSymbolicLink() &&
            realpathSync(path) === path &&
            nativeOwner(path) === store.root &&
            lane?.state !== 'creating',
          'LANE_UNAVAILABLE',
          'The original native Lane owner is unavailable.',
        );
      const after = path ? source.capture(path, false, head) : source.state(head).files;
      if (path) indexTree = source.tree(after);
      const a = new Map(before.map(file => [file.path, file])),
        b = new Map(after.map(file => [file.path, file]));
      for (const file of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        const old = a.get(file),
          next = b.get(file);
        if (old?.blob === next?.blob && old?.mode === next?.mode) continue;
        const before = old ? { hash: old.blob, hashKind: 'sha256' as const, mode: old.mode } : null,
          after = next ? { hash: next.blob, hashKind: 'sha256' as const, mode: next.mode } : null;
        changes.push({ path: file, status: status(before, after), before, after });
      }
      content = change => {
        const before = change.before ? source.object(change.before.hash) : Buffer.alloc(0);
        if (!path)
          return { before, after: change.after ? source.object(change.after.hash) : Buffer.alloc(0) };
        if (!change.after) {
          invariant(
            !existsSync(join(path, change.path)),
            'SOURCE_CHANGED',
            'Deleted live source reappeared after capture.',
          );
          return { before, after: Buffer.alloc(0) };
        }
        const after = nativeFile(path, change.path).bytes;
        invariant(
          after &&
            digest(after) === change.after.hash &&
            nativeFile(path, change.path).mode === change.after.mode,
          'SOURCE_CHANGED',
          'Live bytes or mode changed after capture. Refresh before reviewing.',
        );
        return { before, after };
      };
    } else {
      if (states)
        for (const state of [base, head])
          invariant(
            workGit(store.root, ['cat-file', '-t', state]).trim() === 'commit',
            'BAD_ARGUMENT',
            'Select exact source commits for from and to.',
          );
      if (path) {
        invariant(
          existsSync(path) &&
            !lstatSync(path).isSymbolicLink() &&
            realpathSync(path) === path &&
            lane?.state !== 'creating',
          'LANE_UNAVAILABLE',
          'Lane workspace is unavailable.',
        );
        executionGuard(path);
        invariant(
          workGit(path, ['symbolic-ref', 'HEAD']).trim() === branchFor(lane!.id),
          'LANE_BRANCH_CHANGED',
          'Select the original Lane branch.',
        );
        invariant(headAt(path) === head, 'LANE_STALE', 'The Lane head changed.');
        indexTree = workGit(path, ['write-tree']).trim();
        const stagedChanges = workGit(path, [
          'diff',
          '--cached',
          '--name-only',
          '-z',
          '--no-ext-diff',
          '--no-textconv',
          head,
          '--',
        ])
          .split('\0')
          .filter(Boolean).length;
        const unstagedChanges = workGit(path, [
          'diff',
          '--name-only',
          '-z',
          '--no-ext-diff',
          '--no-textconv',
          '--',
        ])
          .split('\0')
          .filter(Boolean).length;
        untracked = workGit(path, ['ls-files', '--others', '--exclude-standard', '-z'])
          .split('\0')
          .filter(Boolean);
        const untrackedFiles = untracked.length;
        gitSelection = {
          selection: 'live-working-source',
          checkpointSource: 'staged-index',
          stagedChanges,
          unstagedChanges,
          untrackedFiles,
          workingMatchesIndex: unstagedChanges === 0 && untrackedFiles === 0,
        };
      }
      const rows = workGit(path ?? store.root, [
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        base,
        ...(path ? [] : [head]),
        '--',
      ]).split('\0');
      for (let i = 0; i + 1 < rows.length; i += 2) {
        const [oldMode, nextMode, oldHash, nextHash] = rows[i]!.slice(1).split(' '),
          file = rows[i + 1]!;
        invariant(safeRelative(file), 'UNSAFE_PATH', 'Changed source path is invalid.');
        const before =
          oldMode === '000000' ? null : { hash: oldHash!, hashKind: 'git-object' as const, mode: oldMode! };
        let after: File | null =
          nextMode === '000000'
            ? null
            : { hash: nextHash!, hashKind: 'git-object' as const, mode: nextMode! };
        if (path && after) {
          const bytes = readSource(path, file, Number.MAX_SAFE_INTEGER);
          invariant(bytes, 'SOURCE_CHANGED', 'Changed Git source is unavailable.');
          after = {
            hash: digest(bytes),
            hashKind: 'sha256',
            mode: lstatSync(join(path, file)).mode & 0o111 ? '100755' : '100644',
          };
        }
        changes.push({ path: file, status: status(before, after), before, after });
      }
      if (path)
        for (const file of untracked) {
          const bytes = readSource(path, file, Number.MAX_SAFE_INTEGER);
          invariant(bytes, 'SOURCE_CHANGED', 'Added source is unavailable.');
          const existing = changes.find(change => change.path === file),
            after: File = {
              hash: digest(bytes),
              hashKind: 'sha256',
              mode: lstatSync(join(path, file)).mode & 0o111 ? '100755' : '100644',
            };
          if (existing) {
            existing.after = after;
            existing.status = status(existing.before, after);
            recreated.add(file);
          } else changes.push({ path: file, status: 'added', before: null, after });
        }
      // Git treats an index-deleted recreated path as untracked. Compare the
      // consolidated live bytes to the base so identical recreation is unchanged.
      if (path)
        for (let i = changes.length - 1; i >= 0; i--) {
          const change = changes[i]!;
          if (
            recreated.has(change.path) &&
            change.before &&
            change.after?.hashKind === 'sha256' &&
            change.before.mode === change.after.mode &&
            digest(workGit(store.root, ['cat-file', 'blob', change.before.hash], undefined, false, true)) ===
              change.after.hash
          )
            changes.splice(i, 1);
        }
      content = change => {
        const before = change.before
          ? workGit(store.root, ['cat-file', 'blob', change.before.hash], undefined, false, true)
          : Buffer.alloc(0);
        if (!path)
          return {
            before,
            after: change.after
              ? workGit(store.root, ['cat-file', 'blob', change.after.hash], undefined, false, true)
              : Buffer.alloc(0),
          };
        if (!change.after) {
          invariant(
            !existsSync(join(path, change.path)),
            'SOURCE_CHANGED',
            'Deleted live source reappeared.',
          );
          return { before, after: Buffer.alloc(0) };
        }
        const after = nativeFile(path, change.path).bytes;
        invariant(
          after &&
            digest(after) === change.after.hash &&
            (lstatSync(join(path, change.path)).mode & 0o111 ? '100755' : '100644') === change.after.mode,
          'SOURCE_CHANGED',
          'Live Git source changed after capture.',
        );
        return { before, after };
      };
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
    const reviewTree = digest(JSON.stringify({ base, head, indexTree, changes }));
    invariant(
      !command.expectedReviewTree || command.expectedReviewTree === reviewTree,
      'SOURCE_CHANGED',
      'The reviewed source selection changed between requests; restart review pagination.',
    );
    const filtered = command.paths ? changes.filter(change => command.paths!.includes(change.path)) : changes;
    const output: object[] = [];
    let truncated = false;
    const envelope = (rows: object[], cut: boolean) => ({
      revision,
      result: {
        ...pins,
        reviewTree,
        ...(indexTree ? { indexTree } : {}),
        total: changes.length,
        selectedTotal: filtered.length,
        ...gitSelection,
        offset: command.offset,
        more: command.offset + rows.length < filtered.length,
        nextOffset: command.offset + rows.length < filtered.length ? command.offset + rows.length : null,
        truncated: cut,
        changes: rows,
        coverage: 'changed-paths',
        limitations:
          'Review only; unchanged files and external behavior are not assessed. Full review remains available.',
      },
    });
    const size = (rows: object[]) => Buffer.byteLength(JSON.stringify(envelope(rows, false)));
    invariant(
      size([]) <= command.maxBytes,
      'OUTPUT_LIMIT',
      'Exact source pins exceed the requested byte budget; request a larger budget.',
    );
    for (const change of filtered.slice(command.offset, command.offset + command.limit)) {
      const selected = command.paths?.includes(change.path),
        bodies = selected ? content(change) : null;
      let result: object = {
        ...change,
        ...(bodies ? contextualHunks(bodies.before, bodies.after, command.context) : {}),
      };
      if (size([...output, result]) > command.maxBytes && bodies)
        result = {
          ...change,
          hunks: [],
          truncated: true,
          content: 'Hunks exceed the requested byte budget; request one path with a larger budget.',
        };
      if (size([...output, result]) > command.maxBytes) {
        truncated = true;
        break;
      }
      output.push(result);
      if ('truncated' in result && result.truncated) truncated = true;
    }
    if (output.length === 0 && command.offset < filtered.length)
      invariant(
        false,
        'OUTPUT_LIMIT',
        'The next changed path exceeds this byte budget; request a larger maxBytes without advancing offset.',
      );
    return envelope(output, truncated || command.offset + output.length < filtered.length);
  });
}
