// SPDX-License-Identifier: Apache-2.0
import {
  candidateFileList,
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
import { parseNativeState, type NativeFile } from './state/format.js';
import { MemoryMergeSource, MemorySourceReader } from './hosted-source-memory.js';
import { buildHostedComposeState, changedPaths, type ComposeBases } from './hosted-compose-worker.js';
import { buildHostedSyncState } from './hosted-sync-worker.js';
import { syncStateDelta } from './hosted-sync-delta.js';
import { readJson, sourceStepBytes, full, yieldStep, type StepMeter } from './hosted-source-step-verify.js';
import type { SourceStepCursor, StepTransport } from './hosted-source-step.js';
import { sourceWindows, stateSummary } from './hosted-source-fanout.js';
import { mapSourceOrdered } from './hosted-source-parallel.js';
import { ForgeError, invariant } from './errors.js';
import { assertBatchAccounted } from './hosted-batch-coverage.js';
import { sourceValidation } from './hosted-source-validation.js';
import { sourceAncestryCut, sourceAncestryFrontier } from './hosted-source-ancestry-cut.js';
import { sourceGenerationWalk } from './hosted-source-generation-cut.js';
import { describeStackTips, stackedSync } from './hosted-source-stack-tips.js';
import type { WorkerObject } from './hosted-source-worker-format.js';
import { docsMerge } from './docs-resolution.js';

export async function prepareMergeStep(
  c: SourceStepCursor,
  io: StepTransport,
  m: StepMeter,
  /** The action's merge source: tip manifests read here stay for its compute phase. */
  source = new MemoryMergeSource({}),
) {
  if (!c.generations && Object.keys(c.parents).length) c.generationFallback = true;
  io.rememberStateGenerations?.(c.generations ?? {});
  const kind = (c.plan as { kind: string }).kind;
  if (c.phase === 'selection') {
    if (kind === 'forge-hosted-compose-input') {
      const plan = sourceValidation('SOURCE_JOB_INVALID', () => composeInputSchema.parse(c.plan));
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
        value = await readJson(io, pin, m),
        page = sourceValidation('SOURCE_JOB_INVALID', () => validateComposePage(value));
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
        const entry = sourceValidation('SOURCE_JOB_INVALID', () =>
          (c.index === 0 ? composeDependencySchema : composeLaneSchema).parse(value),
        );
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
      const plan = sourceValidation('SOURCE_JOB_INVALID', () => syncInputSchema.parse(c.plan)),
        work = plan.work;
      if (work.mode === 'resolution') {
        c.states = await syncRoots(c, io, m);
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
        } else c.states.push(work.resolution.draftHead);
      }
    }
    c.phase = 'graph';
  }
  const stack = c.phase === 'graph' ? stackedSync(c) : null;
  if (stack) {
    await describeStackTips(c, io, stack);
    return;
  }
  // The first finish commonly composes one saved direct child of current
  // main. Its two verified tip manifests prove the native fast-forward without
  // fetching unrelated retained ancestry.
  // Restore plans reapply an original delta even when its saved head is already
  // an ancestor of reverted main; tip ancestry cannot prove a no-op for them.
  if (
    kind === 'forge-hosted-compose-input' &&
    c.selections.length === 1 &&
    !sourceValidation('SOURCE_JOB_INVALID', () => composeInputSchema.parse(c.plan)).restoreBases
  ) {
    const plan = sourceValidation('SOURCE_JOB_INVALID', () => composeInputSchema.parse(c.plan)),
      right = (c.selections[0] as { head: string }).head,
      left = plan.base.head;
    const tips = [...new Set([left, right])].filter(id => !c.parents[id]);
    // Both tips are read in one action so their manifests also sign changed paths.
    const size = tips.reduce((sum, id) => sum + c.inventory[id]!.object.size, 0);
    if (tips.length && (full(m) || (m.objects && m.bytes + size > sourceStepBytes))) {
      yieldStep(m, 'bytes');
      return;
    }
    for (const id of tips) io.expectState?.(id);
    await io.prepareRead?.(tips.map(id => c.inventory[id]!.object));
    const files = new Map<string, NativeFile[]>();
    const tipStates = await mapSourceOrdered(
      tips,
      async id => await new MemorySourceReader(source, io).state(c.inventory[id]!),
    );
    for (const [index, id] of tips.entries()) {
      const state = tipStates[index]!;
      c.parents[id] = state.parents;
      const generation = io.stateGeneration?.(id);
      if (generation !== undefined) (c.generations ??= {})[id] = generation;
      else c.generationFallback = true;
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
      if (io.seedPhysicalState && !io.hasPhysicalState?.(left)) {
        if (!files.has(left)) await new MemorySourceReader(source, io).bytes(plan.main);
        await io.seedPhysicalState(plan.main.object, files.get(left) ?? source.state(left).files);
      }
      if (io.composePhysicalState && c.head !== left) {
        const ref = c.inventory[c.head]!;
        if (!files.has(c.head)) await new MemorySourceReader(source, io).bytes(ref);
        await io.composePhysicalState(ref.object, files.get(c.head) ?? source.state(c.head).files, left);
      } else if (io.writePhysicalState && !io.hasPhysicalState?.(c.head)) {
        const ref = c.inventory[c.head]!;
        if (!files.has(c.head)) await new MemorySourceReader(source, io).bytes(ref);
        await io.writePhysicalState(ref.object, files.get(c.head) ?? source.state(c.head).files, [left]);
      }
      if (c.composeBases && files.has(c.head)) {
        const listing = candidateFileList(
          plan.base.head,
          c.head,
          new Map(c.composeBases),
          files.get(c.head)!,
          c.selections,
        );
        if (plan.batch)
          assertBatchAccounted(
            plan.batch.members,
            c.selections.flatMap(selection => {
              const dependency = composeDependencySchema.safeParse(selection);
              return dependency.success && plan.batch!.members.includes(dependency.data.candidateId)
                ? [dependency.data.candidateId]
                : [];
            }),
            [],
          );
        const pin = savePin(listing);
        const outputs = await new MemorySourceReader(source, io).publishMany([
          Buffer.from(saveBytes(listing)),
          Buffer.from(
            saveBytes(
              composeResultSchema.parse({
                schema: 1,
                kind: 'forge-hosted-compose-result',
                input: c.input,
                algorithm: plan.algorithm,
                ...(plan.batch ? { dropped: [] } : {}),
                result: {
                  status: 'clean',
                  state: c.inventory[c.head]!.object,
                  candidateFiles: pin,
                  paths: listing.files.map(file => file.path),
                },
              }),
            ),
          ),
        ]);
        c.output = outputs[1]!;
        c.index = 1;
        c.phase = 'done';
        return;
      }
      c.index = 1;
      c.phase = 'compute';
      // The exact tip and changed paths are settled. Finishing publishes only
      // the small result manifest; a fresh merge heap or action would do no work.
      await computeMergeStep(c, io, source);
      return;
    }
  }
  c.states = [...new Set(c.states)].filter(id => !c.parents[id]);
  const roots =
    kind === 'forge-hosted-compose-input'
      ? [
          sourceValidation('SOURCE_JOB_INVALID', () => composeInputSchema.parse(c.plan)).base.head,
          ...c.selections.map(v => (v as { head: string }).head),
          ...Object.values(
            sourceValidation('SOURCE_JOB_INVALID', () => composeInputSchema.parse(c.plan)).restoreBases ?? {},
          ).map(ref => ref.object.sha256),
        ]
      : await syncRoots(c, io, m);
  let walk =
    !c.generationFallback &&
    io.stateGeneration &&
    roots.every(id => c.parents[id]) &&
    !(kind === 'forge-hosted-compose-input' && composeInputSchema.parse(c.plan).restoreBases)
      ? sourceGenerationWalk(c.parents, c.generations ?? {}, roots)
      : null;
  if (walk?.cuts) {
    c.ancestryCuts = walk.cuts;
    c.states = [];
  }
  const boundary = sourceAncestryCut(c.parents, c.states, roots);
  if (boundary) {
    c.ancestryBoundary = boundary;
    c.states = [];
  }
  if (!c.states.length) {
    c.phase = 'compute';
    return;
  }
  if (full(m)) return;
  const readable = c.states.filter(id => !c.ancestryFailures?.[id]);
  if (!readable.length) {
    const id = c.states[0]!;
    throw new ForgeError(c.ancestryFailures![id]!, 'Required source State could not be verified.');
  }
  // A failed probe remains an open edge in both proofs, but is never another
  // byte-read candidate. If it blocks generation priority, advance independent
  // readable work until a sound cut retires it or its original error is required.
  const selectFrontier = () => {
    const preferred = walk?.frontier.filter(id => !c.ancestryFailures?.[id]);
    return preferred?.length
      ? preferred
      : sourceAncestryFrontier(
          c.parents,
          readable.filter(id => !c.ancestryFailures?.[id]),
          roots,
        );
  };
  const frontier = selectFrontier().slice(0, 100),
    extra = resolveRight(c, frontier);
  // Descriptors are resolved by page. Deeper derived hints cannot enter a
  // breadth-first byte window or become a dependency before a nearer branch.
  invariant(io.describeBatch, 'SOURCE_WORKER_UNAVAILABLE', 'Resolve ancestry in windows.');
  let refs: WorkerObject[];
  if (io.probeStates) {
    const probes = await io.probeStates(
      [...frontier, ...extra],
      // Recorded parents let one bounded descriptor page follow a linear chain
      // instead of one call per level; older rows wait for a 32-State walk. The probe that
      // carries a resolve's right tip sends no hints: they would follow that tip into main's
      // history, which the resolve never reads.
      !extra.length &&
        (Object.keys(c.parents).length >= 32 || Object.keys(c.parents).some(id => io.stateParents?.(id)))
        ? {
            known: Object.keys(c.parents).filter(id => !frontier.includes(id)),
            windows: io.fanout && frontier.length > 4 ? 4 : 1,
          }
        : undefined,
    );
    const ids = [...probes.refs.map(ref => ref.object.sha256), ...probes.unavailable];
    invariant(
      ids.length > 0 &&
        new Set(ids).size === ids.length &&
        ids.every(id => frontier.includes(id) || extra.includes(id)),
      'SOURCE_HASH_MISMATCH',
      'Ancestry descriptor page changed its frontier.',
    );
    // The right tip is no ancestry root, so its manifest is never read here; it must still exist,
    // or the resolved State would name a parent that is gone.
    if (probes.unavailable.some(id => extra.includes(id)))
      throw new ForgeError('SOURCE_UNAVAILABLE', 'The conflict right tip is absent.');
    refs = probes.refs.filter(ref => frontier.includes(ref.object.sha256));
    const unavailable = probes.unavailable.filter(id => frontier.includes(id));
    for (const id of unavailable) (c.ancestryFailures ??= {})[id] = 'SOURCE_UNAVAILABLE';
    if (walk && unavailable.length) c.generationFallback = true;
  } else
    refs = (await io.describeBatch([...frontier, ...extra])).filter(ref =>
      frontier.includes(ref.object.sha256),
    );
  if (extra.length) c.resolveRightProbed = true;
  for (const id of extra) {
    const generation = io.stateGeneration?.(id),
      edges = io.stateParents?.(id);
    if (generation !== undefined) (c.generations ??= {})[id] = generation;
    if (edges) c.parents[id] = [...edges];
  }
  if (walk) {
    for (const ref of refs) {
      const id = ref.object.sha256,
        generation = io.stateGeneration?.(id);
      if (generation === undefined) c.generationFallback = true;
      else (c.generations ??= {})[id] = generation;
    }
    if (!c.generationFallback) {
      walk = sourceGenerationWalk(c.parents, c.generations ?? {}, roots);
      if (walk?.cuts) {
        c.ancestryCuts = walk.cuts;
        c.states = [];
        c.phase = 'compute';
        return;
      }
      if (walk?.metadata && walk.frontier.some(id => !c.ancestryFailures?.[id])) return;
      if (walk) {
        const selected = new Set(selectFrontier());
        refs = refs.filter(ref => selected.has(ref.object.sha256));
      }
    }
  }
  // Recorded parents settle these States without a manifest download; only the rest are read.
  const recorded = io.stateParents ? refs.filter(ref => io.stateParents!(ref.object.sha256)) : [];
  if (recorded.length) {
    for (const ref of recorded) {
      const id = ref.object.sha256,
        edges = io.stateParents!(id)!,
        generation = io.stateGeneration?.(id);
      c.parents[id] = [...edges];
      if (generation !== undefined) (c.generations ??= {})[id] = generation;
      else c.generationFallback = true;
      c.states.push(...edges);
    }
    c.states = [...new Set(c.states)].filter(id => !c.parents[id]);
    // Re-enter the proof with the new edges before reading any remaining manifest.
    return;
  }
  const windows = sourceWindows(refs);
  if (io.fanout && windows.length > 1) {
    io.fanout({
      kind: 'states',
      end: 0,
      tasks: windows.map(refs => ({ kind: 'states', refs, files: false })),
    });
    yieldStep(m, 'fanout');
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
    if (refs.length) yieldStep(m, 'window');
    return;
  }
  await io.prepareRead?.(window.filter(r => !r.recipe).map(r => r.object));
  for (const state of await mapSourceOrdered(window, ref => stateSummary(ref, false, io))) {
    if (state.error) (c.ancestryFailures ??= {})[state.id] = state.error;
    else {
      c.parents[state.id] = state.parents;
      if (state.generation !== undefined) (c.generations ??= {})[state.id] = state.generation;
      else c.generationFallback = true;
      c.states.push(...state.parents);
    }
  }
  c.states = [...new Set(c.states)].filter(id => !c.parents[id]);
  // Re-enter the proof even when the last window closed the frontier. A
  // prefetched closed boundary still belongs in the explicit cut record.
}

export async function computeMergeStep(
  c: SourceStepCursor,
  io: StepTransport,
  source = new MemoryMergeSource(c.parents, c.ancestryBoundary, c.ancestryCuts),
) {
  io.rememberStateGenerations?.(c.generations ?? {});
  if ((c.plan as { kind: string }).kind === 'forge-hosted-sync-input') {
    const reader = new MemorySourceReader(source, io);
    const result = await buildHostedSyncState(c.input, c.plan, reader, source, async () => {});
    const own = source.objects.get(result.head);
    // Generated States may still be uploading; their uploader owns the physical
    // recipe. Only an existing fast-forward needs this metadata-only publication.
    if (io.writePhysicalState && !io.hasPhysicalState?.(result.head) && !(own && source.outputState(own))) {
      const selected = source.state(result.head);
      const ref = c.inventory[result.head] ?? (await io.describeBatch!([result.head]))[0]!;
      const work = (
        c.plan as { work: { left?: { object: { sha256: string } }; right?: { object: { sha256: string } } } }
      ).work;
      await io.writePhysicalState(
        ref.object,
        selected.files,
        [work.left?.object.sha256, work.right?.object.sha256].filter((id): id is string => !!id),
      );
    }
    c.output = result.output;
    c.head = result.head;
    c.phase = 'done';
    // The result as changes from the Lane head the client holds (sync and resolve apply it there).
    const work = (c.plan as { work: { mode: string; left?: { object: { sha256: string } } } }).work,
      left = work.mode === 'sync' || work.mode === 'resolve' ? work.left?.object.sha256 : undefined;
    // Full States from their verified bytes: the merge source's `state()` elides message and time
    // (and cut parents) for ancestry walking, which would never rebuild the exact head.
    const verified = (id: string) => {
      try {
        const bytes = source.object(id);
        const state = parseNativeState(bytes);
        io.rememberLoadedState?.({ sha256: id, size: bytes.length }, state.files.length, state.files);
        return state;
      } catch {
        return null;
      }
    };
    const from = left ? verified(left) : null,
      head = from ? verified(result.head) : null;
    const delta = from && head ? syncStateDelta(from, left!, head, result.head) : null;
    if (delta) c.syncDelta = delta;
    return;
  }
  const plan = sourceValidation('SOURCE_JOB_INVALID', () => composeInputSchema.parse(c.plan));
  if (io.seedPhysicalState && !io.hasPhysicalState?.(plan.main.object.sha256)) {
    const reader = new MemorySourceReader(source, io);
    await reader.bytes(plan.main);
    await io.seedPhysicalState(plan.main.object, source.state(plan.main.object.sha256).files);
  }
  // Member accounting starts with the first quantum; an older in-flight cursor has none.
  if (plan.batch && c.index === 0) c.batchMerged ??= [];
  if (c.index >= c.selections.length) {
    invariant(c.head, 'SOURCE_JOB_INVALID', 'Compose has no selected head.');
    if (plan.batch && c.batchMerged) assertBatchAccounted(plan.batch.members, c.batchMerged, c.batchDropped);
    let state = c.inventory[c.head]?.object;
    if (!state) {
      invariant(io.describeBatch, 'SOURCE_WORKER_UNAVAILABLE', 'Resolve final State.');
      state = (await io.describeBatch([c.head]))[0]!.object;
    }
    const reader = new MemorySourceReader(source, io);
    const own = source.objects.get(c.head);
    if (io.composePhysicalState && c.head !== plan.main.object.sha256 && !(own && source.outputState(own))) {
      const ref = c.inventory[c.head] ?? (await io.describeBatch!([c.head]))[0]!;
      await reader.bytes(ref);
      await io.composePhysicalState(state, source.state(c.head).files, plan.main.object.sha256);
    } else if (io.writePhysicalState && !io.hasPhysicalState?.(c.head) && !(own && source.outputState(own))) {
      const ref = c.inventory[c.head] ?? (await io.describeBatch!([c.head]))[0]!;
      await reader.bytes(ref);
      await io.writePhysicalState(state, source.state(c.head).files, [plan.main.object.sha256]);
    }
    const docs = docsMerge(c.docsPaths ?? []);
    const listing =
      !c.candidateFiles && c.composeBases && c.head === plan.base.head
        ? candidateFileList(plan.base.head, c.head, new Map(), [], c.selections)
        : null;
    const listingPin = listing ? savePin(listing) : c.candidateFiles;
    const outputs = await reader.publishMany([
      ...(listing ? [Buffer.from(saveBytes(listing))] : []),
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
              ...(listingPin ? { candidateFiles: listingPin } : {}),
              ...(c.composeBases ? { paths: c.composeBases.map(([path]) => path).sort() } : {}),
              ...(docs ? { docs } : {}),
            },
          }),
        ),
      ),
    ]);
    c.output = outputs.at(-1)!;
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
    c.index + 1 === c.selections.length && !plan.batch
      ? { base: plan.base.head, selections: c.selections }
      : null,
  );
  let manifest = composeResultSchema.parse(JSON.parse(source.object(result.output.sha256).toString('utf8')));
  const member =
    manifest.result.status === 'conflict' &&
    !!plan.batch &&
    'candidateId' in value &&
    plan.batch.members.includes(value.candidateId);
  let againstMain = c.head === plan.base.head;
  if (member && !againstMain) {
    const onMain = await buildHostedComposeState(
      c.input,
      {
        ...plan,
        batch: undefined,
        inputs: inputs.manifest,
        dependencies: dependencies.manifest,
      },
      reader,
      source,
      async () => {},
      undefined,
      null,
    );
    const checked = composeResultSchema.parse(
      JSON.parse(source.object(onMain.output.sha256).toString('utf8')),
    );
    if (checked.result.status === 'conflict') {
      manifest = checked;
      againstMain = true;
    }
  }
  // Docs merges of earlier quanta (one input each) belong on the final result too.
  const docsPaths =
    manifest.result.status === 'clean'
      ? [...new Set([...(c.docsPaths ?? []), ...result.docsPaths])].sort()
      : [];
  let output = result.output;
  if (
    manifest.result.status === 'clean' &&
    !plan.batch &&
    c.index + 1 === c.selections.length &&
    c.docsPaths?.length
  )
    output = await reader.publish(
      Buffer.from(
        saveBytes(
          composeResultSchema.parse({
            ...manifest,
            result: { ...manifest.result, docs: docsMerge(docsPaths) },
          }),
        ),
      ),
    );
  // Publish exactly one listing in the last batch quantum while the final State is resident.
  // The later terminal quantum only references this pin; it never re-reads a whole State.
  let candidateFiles = c.candidateFiles;
  if (plan.batch && c.index + 1 === c.selections.length && (member || manifest.result.status === 'clean')) {
    const finalHead = member
      ? c.head!
      : manifest.result.status === 'clean'
        ? manifest.result.state.sha256
        : c.head!;
    const finalBases = member ? (c.composeBases ? new Map(c.composeBases) : null) : bases;
    if (finalBases)
      candidateFiles = await reader.publish(
        Buffer.from(
          saveBytes(
            candidateFileList(
              plan.base.head,
              finalHead,
              finalBases,
              source.state(finalHead).files,
              c.selections,
            ),
          ),
        ),
      );
  }
  // The quantum commits below, after its last await. Any await above can throw
  // SourceCalculationsPending, and the step re-runs this same index; moving the
  // cursor first skipped a batch member without merging or dropping it (Issue 55bcad06).
  if (bases && !(plan.batch && manifestConflict(result, source))) c.composeBases = [...bases];
  if (docsPaths.length) c.docsPaths = docsPaths;
  if (candidateFiles) c.candidateFiles = candidateFiles;
  c.index++;
  if (member && 'candidateId' in value) {
    invariant(manifest.result.status === 'conflict', 'SOURCE_JOB_INVALID', 'Retain the rejected merge.');
    (c.batchDropped ??= []).push({
      candidateId: value.candidateId,
      ...(againstMain ? { againstMain: true as const } : {}),
      conflicts: manifest.result.conflicts,
      paths: manifest.result.paths,
      more: manifest.result.more,
    });
  } else if (manifest.result.status === 'conflict') {
    c.output = result.output;
    c.head = null;
    c.phase = 'done';
  } else {
    c.head = manifest.result.state.sha256;
    c.inventory[c.head] = { object: manifest.result.state, recipe: null };
    if (
      plan.batch &&
      c.batchMerged &&
      'candidateId' in value &&
      plan.batch.members.includes(value.candidateId)
    )
      c.batchMerged.push(value.candidateId);
    if (c.index === c.selections.length && !plan.batch) {
      const own = source.objects.get(c.head);
      if (io.composePhysicalState && c.head !== plan.main.object.sha256 && !(own && source.outputState(own)))
        await io.composePhysicalState(
          manifest.result.state,
          source.state(c.head).files,
          plan.main.object.sha256,
        );
      c.output = output;
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

/** The selected sync roots, not the prefetched frontier, define the proof. */
async function syncRoots(c: SourceStepCursor, io: StepTransport, m: StepMeter): Promise<string[]> {
  const work = sourceValidation('SOURCE_JOB_INVALID', () => syncInputSchema.parse(c.plan)).work;
  if (work.mode === 'resolution') {
    if (!c.resolutionRoots) {
      // Older in-flight graph cursors recover from the same immutable page.
      // Derived parent hints cannot select or replace either resolution tip.
      const value = await readJson(io, work.conflicts, m);
      const page = sourceValidation('SOURCE_JOB_INVALID', () => composeConflictPageSchema.parse(value));
      invariant(
        canonicalPayload(savePin(page)) === canonicalPayload(work.conflicts),
        'SOURCE_HASH_MISMATCH',
        'Conflict page changed.',
      );
      c.resolutionRoots = [page.left, page.right];
    }
    // The frontier grows independently; never alias its mutable array.
    return [...c.resolutionRoots];
  }
  if (work.mode === 'revert') return [work.previous.object.sha256, work.accepted.object.sha256];
  // A stacked sync never reaches here: its explicit stack base replaces the search (see stackedSync).
  if (work.mode === 'sync') return [work.left.object.sha256, work.right.object.sha256];
  // A resolve asks one ancestry question: does the saved head descend from its draft? The draft is
  // an ancestor of the head, so with more roots (the conflict's tips and base) the generation walk
  // sees a subset-common State and falls back to breadth-first search for a State every root passes
  // through, which in a busy history is far below the merge (Issue 1eef1b43: 40 manifests, 3 steps).
  return [work.left.object.sha256, work.resolution.draftHead];
}

/** A resolve's right tip is no ancestry root, but the resolved State names it as a parent: its
 * descriptor (described in the same probe call) gives that State its generation, and its recorded
 * parents spare the compute step a manifest read. Empty once known, and for every other job. */
function resolveRight(c: SourceStepCursor, frontier: string[]): string[] {
  if ((c.plan as { kind: string }).kind !== 'forge-hosted-sync-input') return [];
  const work = sourceValidation('SOURCE_JOB_INVALID', () => syncInputSchema.parse(c.plan)).work;
  if (work.mode !== 'resolve') return [];
  const right = work.resolution.right;
  // Probed once: a legacy row with neither parents nor a generation stays unknown, and re-adding it
  // to every probe would pull main's history rows into each descriptor page (Issue 1eef1b43).
  return c.resolveRightProbed ||
    c.parents[right] ||
    c.generations?.[right] !== undefined ||
    frontier.includes(right)
    ? []
    : [right];
}
