// SPDX-License-Identifier: Apache-2.0
import {
  conflictMarkerScan,
  scanConflictMarkers,
  conflictMarkersFound,
  type ConflictMarkerScan,
} from './conflict-markers.js';
import type { WorkerObject } from './hosted-source-worker-format.js';
import type { SourceStepCursor, StepTransport } from './hosted-source-step.js';
import type { VerifyCursor } from './hosted-source-step-verify.js';
import { sourceStepBytes, meter, full, verifySourceObject } from './hosted-source-step-verify.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { MemoryMergeSource, MemorySourceReader } from './hosted-source-memory.js';
import { parseNativeState } from './native-state-format.js';
import {
  calculateSourceFiles,
  type SourceCalculation,
  type SourceCalculationResult,
} from './hosted-source-merge-journal.js';
import {
  parseSourceTaskInput,
  parseSourceTaskProgress,
  validateSourceTaskProgress,
} from './hosted-source-task-schema.js';
import { ForgeError, invariant } from './errors.js';
export type SourceTaskInput =
  | { kind: 'verify'; refs: WorkerObject[] }
  | { kind: 'states'; refs: WorkerObject[]; files: boolean }
  | { kind: 'markers'; request: SourceCalculation; refs: WorkerObject[] }
  | { kind: 'calculate'; refs: WorkerObject[]; requests: SourceCalculation[] };
export type SourceFanout = { kind: 'verify' | 'states' | 'calculate'; end: number; tasks: SourceTaskInput[] };
export type SourceStateSummary = {
  generation?: number;
  id: string;
  parents: string[];
  files: string[];
  error: string | null;
};
export type SourceTaskProgress = {
  index: number;
  verify: VerifyCursor | null;
  states: SourceStateSummary[];
  calculations?: SourceCalculationResult[];
  scan?: ConflictMarkerScan;
};
export async function stateSummary(
  ref: WorkerObject,
  files: boolean,
  io: StepTransport,
): Promise<SourceStateSummary> {
  const invalid = (code: string) => ({ id: ref.object.sha256, parents: [], files: [], error: code });
  let bytes: Uint8Array;
  try {
    bytes = await new MemorySourceReader(new MemoryMergeSource({}), io).bytes(ref);
  } catch (error) {
    // Byte acquisition proves invalidity only for exact missing/hash/recipe
    // failures. Unknown I/O and authority/fencing failures escape the prefetch.
    if (
      !(error instanceof ForgeError) ||
      ![
        'SOURCE_UNAVAILABLE',
        'SOURCE_HASH_MISMATCH',
        'SOURCE_RECIPE_INVALID',
        'SOURCE_PAGE_INVALID',
        'INVALID_WORK_BACKUP',
      ].includes(error.code)
    )
      throw error;
    return invalid(error.code);
  }
  try {
    const state = parseNativeState(bytes),
      generation = io.stateGeneration?.(ref.object.sha256);
    return {
      id: ref.object.sha256,
      ...(generation === undefined ? {} : { generation }),
      parents: state.parents,
      files: files
        ? [...new Set([...state.files.map(f => f.blob), ...(state.git ? [state.git.bundle] : [])])]
        : [],
      error: null,
    };
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'INVALID_NATIVE_SOURCE') throw error;
    return invalid(error.code);
  }
}
export function sourceWindows(refs: WorkerObject[]) {
  const groups: WorkerObject[][] = [];
  let group: WorkerObject[] = [],
    bytes = 0;
  for (const ref of refs) {
    if (group.length && (group.length === 100 || bytes + ref.object.size > sourceStepBytes)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(ref);
    bytes += ref.object.size;
    if (ref.object.size >= sourceStepBytes) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
  }
  if (group.length) groups.push(group);
  return groups;
}
export function verificationFanout(c: SourceStepCursor): SourceFanout | null {
  const refs = c.queue.slice(c.queueIndex, c.queueIndex + 800).map(id => c.inventory[id]!);
  const windows = sourceWindows(refs);
  if (windows.length <= 1 && !(refs[0]?.recipe && refs[0].object.size > sourceStepBytes)) return null;
  return {
    kind: 'verify',
    end: c.queueIndex + refs.length,
    tasks: windows.map(refs => ({ kind: 'verify', refs })),
  };
}
export async function runSourceTask(
  input: SourceTaskInput,
  previous: SourceTaskProgress | null,
  original: StepTransport,
) {
  input = parseSourceTaskInput(input);
  if (previous) {
    previous = parseSourceTaskProgress(previous);
    validateSourceTaskProgress(input, previous);
  }
  const progress = structuredClone(previous ?? { index: 0, verify: null, states: [] }),
    m = meter();
  const io: StepTransport = {
    ...original,
    read: async (pin: Parameters<SourceWorkerTransport['read']>[0]) => {
      const stream = await original.read(pin);
      m.objects++;
      return (async function* () {
        for await (const part of stream) {
          m.bytes += part.length;
          yield part;
        }
      })();
    },
  };
  const startIndex = progress.index,
    startVerify = JSON.stringify(progress.verify);
  const finish = (done: boolean) => {
    invariant(
      done || progress.index !== startIndex || JSON.stringify(progress.verify) !== startVerify,
      'SOURCE_JOB_INVALID',
      'A source task continuation made no durable progress.',
    );
    return {
      done,
      progress,
      metrics: {
        objects: m.objects,
        bytes: m.bytes,
        elapsedMs: performance.now() - m.started,
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
      },
    };
  };
  if (input.kind === 'markers') {
    const scan = (progress.scan ??= conflictMarkerScan());
    const consume = (bytes: Uint8Array) => scanConflictMarkers(scan, bytes);
    progress.verify = await verifySourceObject(io, input.refs[0]!, m, progress.verify, consume);
    if (!progress.verify) {
      const found = conflictMarkersFound(scan);
      progress.calculations = [
        { key: input.request.key, blob: null, kind: 'binary', resolutions: [], markers: found },
      ];
    }
    return finish(!progress.verify);
  }
  if (input.kind === 'calculate') {
    const results = await calculateSourceFiles(input, io, progress.index, () => full(m));
    progress.index += results.length;
    (progress.calculations ??= []).push(...results);
    return finish(progress.index === input.requests.length);
  }
  await io.prepareRead?.(input.refs.filter(ref => !ref.recipe).map(ref => ref.object));
  while (progress.index < input.refs.length && !full(m)) {
    const ref = input.refs[progress.index]!;
    if (m.objects && m.bytes + Math.min(ref.object.size, 1024 * 1024) > sourceStepBytes) {
      m.yielded = true;
      break;
    }
    if (input.kind === 'verify') {
      progress.verify = await verifySourceObject(io, ref, m, progress.verify);
      if (progress.verify) break;
    } else progress.states.push(await stateSummary(ref, input.files, io));
    progress.index++;
  }
  return finish(progress.index === input.refs.length);
}
/** Only actually reachable summaries become closure evidence. Extra prefetch
 * hints, including failures, never decide validity or independence. */
export function applySourceFanout(
  c: SourceStepCursor,
  plan: Pick<SourceFanout, 'kind' | 'end'>,
  results: SourceTaskProgress[],
  enqueue: (ref: WorkerObject) => void,
) {
  if (plan.kind === 'calculate') {
    for (const result of results.flatMap(r => r.calculations ?? []))
      (c.calculations ??= {})[result.key] = result;
    return;
  }
  if (plan.kind === 'verify') {
    c.queueIndex = plan.end;
    c.verify = null;
    return;
  }
  const summaries = new Map(
      results.flatMap(result => result.states.map(state => [state.id, state] as const)),
    ),
    pending = [...c.states],
    remaining = new Set<string>(),
    graph = c.phase === 'graph';
  let position = 0;
  while (graph ? position < pending.length : pending.length) {
    const id = graph ? pending[position++]! : pending.pop()!;
    if (c.parents[id]) continue;
    const state = summaries.get(id);
    if (!state) {
      remaining.add(id);
      continue;
    }
    if (graph && state.error) {
      (c.ancestryFailures ??= {})[id] = state.error;
      remaining.add(id);
      continue;
    }
    invariant(
      !state.error,
      state.error ?? 'SOURCE_CLOSURE_INVALID',
      'Required source State could not be verified.',
    );
    c.parents[id] = state.parents;
    if (state.generation !== undefined) (c.generations ??= {})[id] = state.generation;
    else c.generationFallback = true;
    c.seen[id] = true;
    pending.push(...state.parents);
    for (const digest of state.files) {
      const ref = c.inventory[digest];
      invariant(ref, 'SOURCE_CLOSURE_INVALID', 'Required source object is absent from inventory.');
      enqueue(ref);
    }
  }
  c.states = [...remaining].filter(id => !c.parents[id]);
}
