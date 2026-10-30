// SPDX-License-Identifier: Apache-2.0
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { MemoryMergeSource, MemorySourceReader } from './hosted-source-memory.js';
import {
  workerInputSchema,
  workerPageSchema,
  type WorkerObject,
  type WorkerPin,
} from './hosted-source-worker-format.js';
import { saveInputSchema, validateSavePage, savePin, type SaveChange } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import {
  meter,
  full,
  readJson,
  verifySourceObject,
  sourceStepBytes,
  type VerifyCursor,
  type StepMeter,
} from './hosted-source-step-verify.js';
import { publishSourceStepState } from './hosted-source-step-state.js';
import {
  verificationFanout,
  sourceWindows,
  runSourceTask,
  type SourceFanout,
} from './hosted-source-fanout.js';
import {
  journalSourceCalculations,
  calculationWindows,
  SourceCalculationsPending,
} from './hosted-source-merge-journal.js';
import { prepareMergeStep, computeMergeStep } from './hosted-source-step-merge.js';
export interface StepTransport extends SourceWorkerTransport {
  fanout?(plan: SourceFanout): void;
  ancestry?(roots: string[], known: string[], windows?: number): Promise<WorkerObject[]>;
}
export type SourceStepCursor = {
  input: WorkerPin;
  plan: unknown;
  phase: 'input' | 'save' | 'inventory' | 'closure' | 'selection' | 'graph' | 'compute' | 'done';
  next: WorkerPin | null;
  pages: number;
  count: number;
  lastPath: string | null;
  files: NativeFile[];
  changes: SaveChange[];
  inventory: Record<string, WorkerObject>;
  queue: string[];
  queueIndex: number;
  states: string[];
  seen: Record<string, boolean>;
  parents: Record<string, string[]>;
  /** Proven common frontier; older history cannot contain a maximal merge base. */
  ancestryBoundary?: string;
  verify: VerifyCursor | null;
  selections: unknown[];
  head: string | null;
  index: number;
  output: WorkerPin | null;
  changed: boolean;
  calculations?: Record<string, import('./hosted-source-merge-journal.js').SourceCalculationResult>;
  /** Compose base entries of changed paths. Absent on cursors from older code:
   * their changed paths are unknown and the Candidate waits for the owner. */
  batchDropped?: import('./hosted-landing-batch.js').BatchDropped;
  composeBases?: [string, Pick<NativeFile, 'blob' | 'mode'> | null][];
};
export function initialSourceStep(input: WorkerPin): SourceStepCursor {
  return {
    input,
    plan: null,
    phase: 'input',
    next: null,
    pages: 0,
    count: 0,
    lastPath: null,
    files: [],
    changes: [],
    inventory: {},
    queue: [],
    states: [],
    seen: {},
    queueIndex: 0,
    parents: {},
    verify: null,
    selections: [],
    head: null,
    index: 0,
    output: null,
    changed: false,
    calculations: {},
    composeBases: [],
  };
}
async function verifyQueue(c: SourceStepCursor, io: StepTransport, m: StepMeter) {
  if (io.fanout) {
    const plan = verificationFanout(c);
    if (plan) {
      io.fanout(plan);
      m.yielded = true;
      return;
    }
  }
  const refs = c.queue.slice(c.queueIndex, c.queueIndex + 100).map(id => c.inventory[id]!);
  // A single metadata/transfer window prepares the physical raw objects. Recipe
  // frontiers prepare their own bounded windows in the transport.
  await io.prepareRead?.(refs.filter(ref => !ref.recipe).map(ref => ref.object));
  while (c.queueIndex < c.queue.length && !full(m)) {
    const id = c.queue[c.queueIndex]!,
      ref = c.inventory[id];
    invariant(ref, 'SOURCE_CLOSURE_INVALID', 'Required source object is absent from inventory.');
    if (m.objects && !ref.recipe && m.bytes + ref.object.size > sourceStepBytes) {
      m.yielded = true;
      break;
    }
    c.verify = await verifySourceObject(io, ref, m, c.verify);
    if (c.verify) break;
    c.queueIndex++;
  }
}
export function enqueueSourceObject(c: SourceStepCursor, ref: WorkerObject) {
  const id = ref.object.sha256,
    old = c.inventory[id];
  invariant(
    !old || old === ref || canonicalPayload(old) === canonicalPayload(ref),
    'SOURCE_CLOSURE_INVALID',
    'Source inventory changed a pin.',
  );
  c.inventory[id] = ref;
  if (!(id in c.seen)) {
    c.seen[id] = true;
    c.queue.push(id);
  }
}
async function saveStep(c: SourceStepCursor, io: StepTransport, m: StepMeter) {
  const plan = saveInputSchema.parse(c.plan);
  if (c.pages === 0 && c.count === 0 && !c.files.length && !c.changes.length) {
    const source = new MemoryMergeSource(c.parents, c.ancestryBoundary),
      reader = new MemorySourceReader(source, io);
    await io.prepareRead?.([plan.baseline.object, plan.pages]);
    const baseline = parseNativeState(await reader.bytes(plan.baseline));
    c.files = baseline.files;
    // The baseline is registered immutable source authority; a rename or mode
    // change reuses its verified bytes. Staging checked the exact object recipe.
    for (const file of baseline.files) c.seen[file.blob] = true;
    c.parents[plan.baseline.object.sha256] = baseline.parents;
  }
  if (c.changes.length && !(c.next && c.pages % 8 !== 0)) {
    if (m.treeUpdates) {
      m.yielded = true;
      return;
    }
    m.treeUpdates++;
    await verifyQueue(c, io, m);
    if (c.queueIndex < c.queue.length) return;
    const files = new Map(c.files.map(f => [f.path, f]));
    for (const change of c.changes) {
      const old = files.get(change.path);
      invariant(
        canonicalPayload(old ? { blob: old.blob, mode: old.mode } : null) === canonicalPayload(change.before),
        'WORK_STALE',
        'Delta does not match registered baseline.',
      );
      const after = change.after ? { blob: change.after.blob, mode: change.after.mode } : null;
      if (canonicalPayload(after) !== canonicalPayload(change.before)) c.changed = true;
      if (change.after)
        files.set(change.path, { path: change.path, blob: change.after.blob, mode: change.after.mode });
      else files.delete(change.path);
    }
    c.files = [...files.values()];
    c.changes = [];
  }
  if (c.next && !full(m)) {
    const pin = c.next,
      validated = validateSavePage(await readJson(io, pin, m), c.lastPath),
      page = validated.page;
    invariant(
      canonicalPayload(savePin(page)) === canonicalPayload(pin),
      'SOURCE_HASH_MISMATCH',
      'Save page is not canonical.',
    );
    c.pages++;
    c.count += page.changes.length;
    invariant(
      c.pages <= plan.pageCount && c.count <= plan.changeCount,
      'SOURCE_CLOSURE_INVALID',
      'Save delta exceeds pinned counts.',
    );
    c.lastPath = validated.lastPath;
    c.next = page.next;
    c.changes.push(...page.changes);
    for (const change of page.changes) if (change.after) enqueueSourceObject(c, change.after.content);
    return;
  }
  if (!c.next && !c.changes.length) {
    invariant(
      c.pages === plan.pageCount && c.count === plan.changeCount,
      'SOURCE_CLOSURE_INVALID',
      'Save delta is incomplete.',
    );
    c.phase = 'compute';
  }
}
async function inventoryStep(c: SourceStepCursor, io: StepTransport, m: StepMeter) {
  const plan = workerInputSchema.parse(c.plan);
  if (c.next) {
    invariant(!c.seen[c.next.sha256], 'SOURCE_CLOSURE_INVALID', 'Inventory pages repeat.');
    c.seen[c.next.sha256] = true;
    const page = workerPageSchema.parse(await readJson(io, c.next, m));
    for (const ref of page.objects) {
      const old = c.inventory[ref.object.sha256];
      invariant(
        !old || canonicalPayload(old) === canonicalPayload(ref),
        'SOURCE_CLOSURE_INVALID',
        'Inventory changed a pin.',
      );
      c.inventory[ref.object.sha256] = ref;
    }
    c.files.push(...page.files);
    c.next = page.next;
    c.pages++;
  }
  if (!c.next) {
    c.states = [...plan.parents];
    c.phase = 'closure';
  }
}
async function closureStep(c: SourceStepCursor, io: StepTransport, m: StepMeter) {
  let prepared: Set<string> | null = null;
  if (io.fanout && io.ancestry && c.states.some(id => !c.parents[id])) {
    const refs = await io.ancestry(
      c.states
        .slice(-100)
        .reverse()
        .filter(id => !c.parents[id]),
      Object.keys(c.parents),
      4,
    );
    const required = refs.filter(ref => c.inventory[ref.object.sha256]);
    prepared = new Set(required.map(ref => ref.object.sha256));
    if (sourceWindows(required).length > 1) {
      io.fanout({
        kind: 'states',
        end: 0,
        tasks: sourceWindows(required).map(refs => ({ kind: 'states', refs, files: true })),
      });
      m.yielded = true;
      return;
    }
  }
  if (!prepared && io.ancestry && c.states.length) {
    const hints = await io.ancestry(c.states.slice(-100).reverse(), Object.keys(c.parents));
    prepared = new Set(hints.map(ref => ref.object.sha256));
  }
  while (c.states.length && !full(m)) {
    const id = c.states.pop()!;
    if (c.parents[id]) continue;
    const ref = c.inventory[id];
    invariant(ref, 'SOURCE_CLOSURE_INVALID', 'Required ancestor is absent.');
    if (prepared && !prepared.has(id)) {
      c.states.push(id);
      m.yielded = true;
      break;
    }
    if (m.objects && m.bytes + ref.object.size > sourceStepBytes) {
      c.states.push(id);
      m.yielded = true;
      break;
    }
    const source = new MemoryMergeSource({}),
      reader = new MemorySourceReader(source, io);
    const state = parseNativeState(await reader.bytes(ref));
    c.parents[id] = state.parents;
    c.seen[id] = true;
    c.states.push(...state.parents);
    for (const file of state.files) {
      const object = c.inventory[file.blob];
      invariant(object, 'SOURCE_CLOSURE_INVALID', 'Required file is absent.');
      enqueueSourceObject(c, object);
    }
    if (state.git) {
      const object = c.inventory[state.git.bundle];
      invariant(object, 'SOURCE_CLOSURE_INVALID', 'Git bundle is absent.');
      enqueueSourceObject(c, object);
    }
  }
  if (c.states.length) return;
  for (const file of c.files) {
    const ref = c.inventory[file.blob];
    invariant(ref, 'SOURCE_CLOSURE_INVALID', 'Required file is absent.');
    enqueueSourceObject(c, ref);
  }
  await verifyQueue(c, io, m);
  if (c.queueIndex === c.queue.length) c.phase = 'compute';
}
/** One deterministic, retryable quantum. Caller atomically commits the cursor
 * and its successor schedule; repository bytes never choose executable code. */
export async function runSourceStep(cursor: SourceStepCursor, io: StepTransport) {
  const c = structuredClone(cursor),
    m = meter(),
    original = io;
  const mergeSource = new MemoryMergeSource(c.parents, c.ancestryBoundary);
  io = {
    ...original,
    upload: async (pin, bytes) => {
      await original.upload(pin, bytes);
      m.outputObjects++;
      m.outputBytes += pin.size;
    },
    ...(original.uploadBatch
      ? {
          uploadBatch: async (objects: Parameters<NonNullable<StepTransport['uploadBatch']>>[0]) => {
            await original.uploadBatch!(objects);
            m.outputObjects += objects.length;
            m.outputBytes += objects.reduce((sum, o) => sum + o.pin.size, 0);
          },
        }
      : {}),
    read: async pin => {
      const stream = await original.read(pin);
      m.objects++;
      return (async function* () {
        for await (const chunk of stream) {
          m.bytes += chunk.length;
          yield chunk;
        }
      })();
    },
  };
  while (c.phase !== 'done' && !full(m)) {
    if (c.phase === 'input') {
      c.plan = await readJson(io, c.input, m);
      const kind = (c.plan as { kind: string }).kind;
      if (kind === 'forge-hosted-save-input') {
        const p = saveInputSchema.parse(c.plan);
        c.next = p.pages;
        c.phase = 'save';
      } else if (kind === 'forge-source-worker-state') {
        const p = workerInputSchema.parse(c.plan);
        c.next = p.pages;
        c.phase = 'inventory';
      } else {
        c.phase = 'selection';
      }
    } else if (c.phase === 'save') await saveStep(c, io, m);
    else if (c.phase === 'inventory') await inventoryStep(c, io, m);
    else if (c.phase === 'closure') await closureStep(c, io, m);
    else if (c.phase === 'selection' || c.phase === 'graph') await prepareMergeStep(c, io, m);
    else if (c.phase === 'compute') {
      // The graph can establish its cut earlier in this same quantum.
      mergeSource.ancestryBoundary = c.ancestryBoundary;
      const kind = (c.plan as { kind: string }).kind;
      if (kind === 'forge-hosted-save-input' || kind === 'forge-source-worker-state')
        await publishSourceStepState(c, io);
      else {
        // Large manifests read for ancestry in this action stay live until it
        // returns; whole-State merge computation starts with a fresh heap.
        if (m.bytes > 2 * 1024 * 1024) {
          m.yielded = true;
          break;
        }
        if (c.index < c.selections.length) {
          const refs = [
            ...(c.head ? [c.inventory[c.head]] : []),
            ...c.selections.slice(c.index, c.index + 99).map(v => c.inventory[(v as { head: string }).head]),
          ].filter((r): r is WorkerObject => !!r);
          // Generated intermediate States are resident until this quantum commits;
          // they have no published descriptor to resolve yet.
          await io.prepareRead?.(
            refs.filter(ref => !mergeSource.objects.has(ref.object.sha256)).map(ref => ref.object),
          );
        }
        const pending = journalSourceCalculations(c, mergeSource);
        const guarded = {
          ...io,
          upload: async (...args: Parameters<StepTransport['upload']>) => {
            if (pending.size) throw new SourceCalculationsPending();
            return io.upload(...args);
          },
        };
        delete guarded.uploadBatch;
        try {
          await computeMergeStep(c, guarded, mergeSource);
        } catch (error) {
          if (!(error instanceof SourceCalculationsPending)) throw error;
        }
        if (pending.size) {
          const tasks = await calculationWindows([...pending.values()], io);
          if (io.fanout) io.fanout({ kind: 'calculate', end: 0, tasks });
          else
            for (const task of tasks) {
              let previous: import('./hosted-source-fanout.js').SourceTaskProgress | null = null,
                result;
              do {
                result = await runSourceTask(task, previous, io);
                previous = result.progress;
              } while (!result.done);
              for (const value of result.progress.calculations ?? [])
                (c.calculations ??= {})[value.key] = value;
            }
          m.yielded = true;
        }
      }
    }
  }
  return {
    cursor: c,
    metrics: {
      objects: m.objects,
      bytes: m.bytes,
      elapsedMs: performance.now() - m.started,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    },
  };
}
