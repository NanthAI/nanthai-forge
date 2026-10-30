// SPDX-License-Identifier: Apache-2.0
import {
  composeInputSchema,
  composeLaneSchema,
  composeDependencySchema,
  validateComposePage,
  buildComposePages,
  composeResultSchema,
  composeConflictPageSchema,
} from './hosted-compose.js';
import { syncInputSchema } from './hosted-sync.js';
import { saveBytes, savePin } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { MemoryMergeSource, MemorySourceReader } from './hosted-source-memory.js';
import { buildHostedComposeState, changedPaths, type ComposeBases } from './hosted-compose-worker.js';
import { buildHostedSyncState } from './hosted-sync-worker.js';
import { readJson, sourceStepBytes, full, type StepMeter } from './hosted-source-step-verify.js';
import type { SourceStepCursor, StepTransport } from './hosted-source-step.js';
import { sourceWindows } from './hosted-source-fanout.js';
import { invariant } from './errors.js';
import { sourceAncestryCut } from './hosted-source-ancestry-cut.js';
import type { WorkerObject } from './hosted-source-worker-format.js';

export async function prepareMergeStep(c: SourceStepCursor, io: StepTransport, m: StepMeter) {
  const kind = (c.plan as { kind: string }).kind;
  if (c.phase === 'selection') {
    if (kind === 'forge-hosted-compose-input') {
      const plan = composeInputSchema.parse(c.plan);
      invariant(
        plan.main.object.sha256 === plan.base.head,
        'SOURCE_JOB_INVALID',
        'Compose main pins differ.',
      );
      const manifest = c.index === 0 ? plan.dependencies : plan.inputs;
      c.next ??= manifest.root;
      invariant(!c.seen[c.next.sha256], 'SOURCE_CLOSURE_INVALID', 'Compose pages repeat.');
      c.seen[c.next.sha256] = true;
      const pin = c.next,
        page = validateComposePage(await readJson(io, pin, m));
      invariant(
        canonicalPayload(savePin(page)) === canonicalPayload(pin),
        'SOURCE_HASH_MISMATCH',
        'Compose page is not canonical.',
      );
      c.pages++;
      c.count += page.entries.length;
      invariant(
        c.pages <= manifest.pages && c.count <= manifest.count,
        'SOURCE_CLOSURE_INVALID',
        'Compose selection exceeds pinned counts.',
      );
      for (const value of page.entries) {
        const entry = (c.index === 0 ? composeDependencySchema : composeLaneSchema).parse(value);
        invariant(
          entry.head === entry.state.object.sha256,
          'SOURCE_JOB_INVALID',
          'Compose State differs from head.',
        );
        c.inventory[entry.head] = entry.state;
        c.selections.push(entry);
      }
      c.next = page.next;
      if (c.next) return;
      invariant(
        c.pages === manifest.pages && c.count === manifest.count,
        'SOURCE_CLOSURE_INVALID',
        'Compose selection is incomplete.',
      );
      c.index++;
      c.pages = 0;
      c.count = 0;
      if (c.index === 1) return;
      c.head = plan.base.head;
      c.inventory[plan.base.head] = plan.main;
      c.states = [plan.base.head, ...c.selections.map(v => (v as { head: string }).head)];
      c.index = 0;
    } else {
      const plan = syncInputSchema.parse(c.plan),
        work = plan.work;
      if (work.mode === 'resolution') {
        const page = composeConflictPageSchema.parse(await readJson(io, work.conflicts, m));
        invariant(
          canonicalPayload(savePin(page)) === canonicalPayload(work.conflicts),
          'SOURCE_HASH_MISMATCH',
          'Conflict page changed.',
        );
        c.states = [page.left, page.right];
      } else if (work.mode === 'revert') {
        c.inventory[work.previous.object.sha256] = work.previous;
        c.inventory[work.accepted.object.sha256] = work.accepted;
        c.states = [work.previous.object.sha256, work.accepted.object.sha256];
      } else {
        c.inventory[work.left.object.sha256] = work.left;
        c.states = [work.left.object.sha256];
        if (work.mode === 'sync') {
          c.inventory[work.right.object.sha256] = work.right;
          c.states.push(work.right.object.sha256);
          if (work.stackBase) {
            c.inventory[work.stackBase.object.sha256] = work.stackBase;
            c.states.push(work.stackBase.object.sha256);
          }
        } else
          c.states.push(
            work.resolution.left,
            work.resolution.right,
            work.resolution.draftHead,
            ...(work.resolution.mergeBase ? [work.resolution.mergeBase] : []),
          );
      }
    }
    c.phase = 'graph';
  }
  // The first finish commonly composes one saved direct child of current
  // main. Its two verified tip manifests prove the native fast-forward without
  // fetching unrelated retained ancestry.
  // Restore plans reapply an original delta even when its saved head is already
  // an ancestor of reverted main; tip ancestry cannot prove a no-op for them.
  if (
    kind === 'forge-hosted-compose-input' &&
    c.selections.length === 1 &&
    !composeInputSchema.parse(c.plan).restoreBases
  ) {
    const plan = composeInputSchema.parse(c.plan),
      right = (c.selections[0] as { head: string }).head,
      left = plan.base.head;
    const tips = [...new Set([left, right])].filter(id => !c.parents[id]);
    // Both tips are read in one action so their manifests also sign changed paths.
    const size = tips.reduce((sum, id) => sum + c.inventory[id]!.object.size, 0);
    if (tips.length && (full(m) || (m.objects && m.bytes + size > sourceStepBytes))) {
      m.yielded = true;
      return;
    }
    await io.prepareRead?.(tips.map(id => c.inventory[id]!.object));
    const files = new Map<string, NativeFile[]>();
    for (const id of tips) {
      const reader = new MemorySourceReader(new MemoryMergeSource({}), io),
        state = parseNativeState(await reader.bytes(c.inventory[id]!));
      c.parents[id] = state.parents;
      c.states.push(...state.parents);
      files.set(id, state.files);
    }
    if (left === right || c.parents[left]!.includes(right) || c.parents[right]!.includes(left)) {
      c.head = left === right || c.parents[left]!.includes(right) ? left : right;
      if (c.head !== left && c.composeBases) {
        if (files.has(left) && files.has(right)) {
          const bases: ComposeBases = new Map();
          changedPaths(bases, files.get(left)!, files.get(right)!);
          c.composeBases = [...bases];
        } else delete c.composeBases;
      }
      c.index = 1;
      c.phase = 'compute';
      return;
    }
  }
  c.states = [...new Set(c.states)].filter(id => !c.parents[id]);
  const boundary = sourceAncestryCut(c.parents, c.states);
  if (boundary) {
    c.ancestryBoundary = boundary;
    c.states = [];
  }
  if (!c.states.length) {
    c.phase = 'compute';
    return;
  }
  if (full(m)) return;
  // Derived parent rows are prefetch hints only. Every returned manifest is
  // hash verified and its actual parents extend the frontier, even on gaps.
  let refs: WorkerObject[];
  if (io.ancestry && Object.keys(c.parents).length >= 32)
    refs = await io.ancestry(c.states.slice(0, 100), Object.keys(c.parents), io.fanout ? 4 : 1);
  else {
    // Nearby branches usually meet after a few verified frontiers. Reading a
    // 400-State hint window first can cross that common cut and transfer the
    // whole retained history before we can prove it unnecessary. Deep graphs
    // retain the existing paged hint traversal after this bounded local search.
    invariant(io.describeBatch, 'SOURCE_WORKER_UNAVAILABLE', 'Resolve ancestry in windows.');
    refs = await io.describeBatch(c.states.slice(0, 100));
  }
  const windows = sourceWindows(refs);
  if (io.fanout && windows.length > 1) {
    io.fanout({
      kind: 'states',
      end: 0,
      tasks: windows.map(refs => ({ kind: 'states', refs, files: false })),
    });
    m.yielded = true;
    return;
  }
  let bytes = 0;
  const window: WorkerObject[] = [];
  for (const ref of refs) {
    if (window.length + m.objects >= 100) break;
    if (m.objects && bytes + ref.object.size > sourceStepBytes - m.bytes) break;
    if (window.length && bytes + ref.object.size > sourceStepBytes) break;
    window.push(ref);
    bytes += ref.object.size;
  }
  if (!window.length) {
    m.yielded = true;
    return;
  }
  await io.prepareRead?.(window.filter(r => !r.recipe).map(r => r.object));
  const source = new MemoryMergeSource({}),
    reader = new MemorySourceReader(source, io);
  for (const ref of window) {
    const state = parseNativeState(await reader.bytes(ref));
    c.parents[ref.object.sha256] = state.parents;
    c.states.push(...state.parents);
    // Only the selected tips need their descriptors in later calculations.
    source.objects.clear();
  }
  c.states = [...new Set(c.states)].filter(id => !c.parents[id]);
  if (!c.states.length) c.phase = 'compute';
}
export async function computeMergeStep(
  c: SourceStepCursor,
  io: StepTransport,
  source = new MemoryMergeSource(c.parents, c.ancestryBoundary),
) {
  if ((c.plan as { kind: string }).kind === 'forge-hosted-sync-input') {
    const reader = new MemorySourceReader(source, io);
    const result = await buildHostedSyncState(c.input, c.plan, reader, source, async () => {});
    c.output = result.output;
    c.head = result.head;
    c.phase = 'done';
    return;
  }
  const plan = composeInputSchema.parse(c.plan);
  if (c.index >= c.selections.length) {
    invariant(c.head, 'SOURCE_JOB_INVALID', 'Compose has no selected head.');
    let state = c.inventory[c.head]?.object;
    if (!state) {
      invariant(io.describeBatch, 'SOURCE_WORKER_UNAVAILABLE', 'Resolve final State.');
      state = (await io.describeBatch([c.head]))[0]!.object;
    }
    const reader = new MemorySourceReader(source, io);
    c.output = await reader.publish(
      Buffer.from(
        saveBytes(
          composeResultSchema.parse({
            schema: 1,
            kind: 'forge-hosted-compose-result',
            ...(plan.batch ? { dropped: c.batchDropped ?? [] } : {}),
            input: c.input,
            algorithm: plan.algorithm,
            // A fast-forward records exactly the tip difference.
            result: {
              status: 'clean',
              state,
              ...(c.composeBases ? { paths: c.composeBases.map(([path]) => path).sort() } : {}),
            },
          }),
        ),
      ),
    );
    c.phase = 'done';
    return;
  }
  const entry = composeLaneSchema.safeParse(c.selections[c.index]);
  const value = entry.success ? entry.data : composeDependencySchema.parse(c.selections[c.index]);
  const inputs = buildComposePages(entry.success ? [value] : []),
    dependencies = buildComposePages(entry.success ? [] : [value]),
    local = new Map<string, Buffer>();
  for (const page of [...inputs.pages, ...dependencies.pages])
    local.set(page.pin.sha256, Buffer.from(saveBytes(page.value)));
  const reader = new MemorySourceReader(source, {
    ...io,
    read: async pin =>
      local.has(pin.sha256)
        ? (async function* () {
            yield local.get(pin.sha256)!;
          })()
        : io.read(pin),
  });
  invariant(c.head, 'SOURCE_JOB_INVALID', 'Compose head is absent.');
  let main = c.inventory[c.head];
  if (!main) {
    invariant(io.describeBatch, 'SOURCE_WORKER_UNAVAILABLE', 'Resolve intermediate State.');
    main = (await io.describeBatch([c.head]))[0]!;
  }
  const bases: ComposeBases | null = c.composeBases ? new Map(c.composeBases) : null;
  const result = await buildHostedComposeState(
    c.input,
    {
      ...plan,
      batch: undefined, // This quantum retains its own member-conflict result.
      base: { ...plan.base, head: c.head },
      main,
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
    },
    reader,
    source,
    async () => {},
    bases,
  );
  if (bases && !(plan.batch && manifestConflict(result, source))) c.composeBases = [...bases];
  const manifest = composeResultSchema.parse(
    JSON.parse(source.object(result.output.sha256).toString('utf8')),
  );
  c.index++;
  if (
    manifest.result.status === 'conflict' &&
    plan.batch &&
    'candidateId' in value &&
    plan.batch.members.includes(value.candidateId)
  ) {
    (c.batchDropped ??= []).push({ candidateId: value.candidateId, conflicts: manifest.result.conflicts });
  } else if (manifest.result.status === 'conflict') {
    c.output = result.output;
    c.head = null;
    c.phase = 'done';
  } else {
    c.head = manifest.result.state.sha256;
    c.inventory[c.head] = { object: manifest.result.state, recipe: null };
    if (c.index === c.selections.length && !plan.batch) {
      c.output = result.output;
      c.phase = 'done';
    }
  }
}

function manifestConflict(result: { output: { sha256: string } }, source: MemoryMergeSource) {
  return (
    composeResultSchema.parse(JSON.parse(source.object(result.output.sha256).toString('utf8'))).result
      .status === 'conflict'
  );
}
