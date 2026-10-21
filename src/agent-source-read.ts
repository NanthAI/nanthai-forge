// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { agentStateDiffSchema, readAgentReview, readAgentStateDiff } from './agent-review.js';
import { invariant } from './errors.js';
import { safeRelative } from './files.js';
import { NativeSource } from './native-source.js';
import { reviewTextPage } from './native-source-review.js';
import { workGit } from './work-git.js';
import { gitCommand, gitFailure, gitTimeout } from './work-git-command.js';
import type { WorkStore } from './work-store.js';

const state = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const agentDiffSchema = agentStateDiffSchema
  .partial({ from: true, to: true })
  .extend({
    laneId: z.string().uuid().optional(),
    expectedHead: state.optional(),
  })
  .strict()
  .refine(
    input =>
      input.laneId
        ? input.from === undefined && input.to === undefined
        : !!input.from && !!input.to && input.expectedHead === undefined,
    'Select laneId, or both from and to.',
  );
export const agentShowSchema = z
  .object({
    state: state.optional(),
    laneId: z.string().uuid().optional(),
    path: z.string().refine(safeRelative),
    force: z.boolean().default(false),
  })
  .strict()
  .refine(input => !!input.state !== !!input.laneId, 'Select exactly one state or laneId.');

export function readAgentDiff(store: WorkStore, input: z.input<typeof agentDiffSchema>) {
  const { laneId, from, to, expectedHead, ...options } = agentDiffSchema.parse(input);
  if (!laneId) return readAgentStateDiff(store, { from: from!, to: to!, ...options });
  const lane = store.select('lanes', laneId);
  invariant(lane, 'NOT_FOUND', 'Lane not found.');
  return readAgentReview(store, {
    kind: 'lane',
    id: laneId,
    expectedHead: expectedHead ?? lane.head,
    ...options,
  });
}

export const SHOW_MAX_BYTES = 1024 * 1024;
function checkSize(size: number, force: boolean) {
  invariant(
    force || size <= SHOW_MAX_BYTES,
    'FILE_LIMIT',
    'File exceeds 1 MiB; use force:true to read exact bytes.',
  );
}
function gitFile(store: WorkStore, head: string, path: string, force: boolean) {
  invariant(
    workGit(store.root, ['cat-file', '-t', head]).trim() === 'commit',
    'BAD_ARGUMENT',
    'Select an exact source commit.',
  );
  const row = workGit(store.root, ['ls-tree', '-z', head, '--', `:(literal)${path}`])
    .split('\0')
    .find(row => row.slice(row.indexOf('\t') + 1) === path);
  invariant(row, 'NOT_FOUND', 'File is absent from the selected State.');
  const [mode, type, blob] = row.slice(0, row.indexOf('\t')).split(' ');
  invariant(type === 'blob' && blob, 'NOT_FOUND', 'Select a file in the pinned State.');
  const size = Number(workGit(store.root, ['cat-file', '-s', blob]).trim());
  checkSize(size, force);
  const command = gitCommand(store.root, ['cat-file', 'blob', blob]);
  let bytes: Buffer;
  try {
    bytes = execFileSync('git', command.args, {
      env: command.env,
      timeout: gitTimeout(),
      maxBuffer: Math.max(size + 1, 4096),
    });
  } catch (error) {
    throw gitFailure(error, ['cat-file', 'blob', blob]);
  }
  return { blob, mode: mode!, bytes };
}

/** Read only retained source: never the Lane working copy or a symlink target. */
export function readAgentShow(store: WorkStore, input: z.input<typeof agentShowSchema>) {
  const command = agentShowSchema.parse(input);
  return store.locked(() => {
    const lane = command.laneId ? store.select('lanes', command.laneId) : undefined;
    invariant(!command.laneId || lane, 'NOT_FOUND', 'Lane not found.');
    const head = command.state ?? lane!.head;
    invariant(head, 'SOURCE_UNAVAILABLE', 'The selected Lane has no saved State.');
    let file: { blob: string; mode: string; bytes: Buffer };
    if (store.native) {
      const source = new NativeSource(store.root),
        entry = source.state(head).files.find(file => file.path === command.path);
      invariant(entry, 'NOT_FOUND', 'File is absent from the selected State.');
      const bytes = source.object(entry.blob);
      checkSize(bytes.length, command.force);
      file = { ...entry, bytes };
    } else file = gitFile(store, head, command.path, command.force);
    const binary = reviewTextPage(file.bytes).kind === 'binary';
    invariant(
      command.force || !binary,
      'BINARY_FILE',
      'File is binary or invalid UTF-8; use force:true to read exact bytes.',
    );
    return {
      revision: store.revision(),
      result: {
        state: head,
        ...(command.laneId ? { laneId: command.laneId } : {}),
        path: command.path,
        blob: file.blob,
        mode: file.mode,
        size: file.bytes.length,
        encoding: binary ? ('base64' as const) : ('utf8' as const),
        content: file.bytes.toString(binary ? 'base64' : 'utf8'),
      },
    };
  });
}
