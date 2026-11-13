// SPDX-License-Identifier: Apache-2.0
// Local real-handler/R2-fake measurement of a hosted Lane sync and its resolve when main is
// `distance` States ahead of the Lane's base (issue 1eef1b43). No network, no repository code.
// Usage: node tests/measure-sync-ancestry.mjs [files] [changed] [distance]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { saveBytes, buildSavePages } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';

const path = i => `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`;

/** One shared base tree of `files` paths; main moves `distance` States (one path each, the last
 * also changes the `changed` selected paths); the Lane changes the same selected paths (a
 * conflict) or `changed` other paths (clean). Every State carries persisted generation metadata. */
export async function syncHistory(
  s,
  { files, changed, distance, conflict, recordParents = true, recipeBase = false },
) {
  const generations = new Map(),
    blob = async text => s.putSpec(Buffer.from(`${text}\n`));
  const shared = await blob('synthetic'),
    tree = Array.from({ length: files }, (_, i) => ({ path: path(i), mode: 'file', blob: shared.sha256 }));
  const state = async (parents, message, overrides) => {
    const list = tree.map(file =>
      overrides.has(file.path) ? { ...file, blob: overrides.get(file.path) } : file,
    );
    const bytes = Buffer.from(
        saveBytes({
          schema: 1,
          kind: 'forge-source-state',
          parents: parents.map(pin => pin.sha256),
          files: list,
          message,
          at,
        }),
      ),
      pin = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    // Worker-made parents (a conflict draft) have their generation on the published row.
    const level = id =>
      generations.get(id) ??
      [...s.tables.projectObjects.values()].find(row => row.digest === id)?.stateGeneration;
    const generation = 1 + Math.max(0, ...parents.map(parent => level(parent.sha256)));
    generations.set(pin.sha256, generation);
    // Bytes are regenerated on read so a 58k-file history does not stay resident.
    const json = bytes.toString();
    return s.putSpec(
      { size: pin.size, generate: () => Buffer.from(json) },
      pin,
      generation,
      recordParents ? { parents: parents.map(parent => parent.sha256) } : {},
    );
  };
  const base = await state([], 'base', new Map());
  if (recipeBase) {
    const built = buildObjectRecipe(await s.bytes(base));
    for (const value of built.objects.values()) await s.putSpec(value);
    const recipe = await s.putSpec(built.bytes);
    const row = [...s.tables.projectObjects.values()].find(row => row.digest === base.sha256);
    // Legacy host bootstrap has no trusted recipeClosure projection.
    Object.assign(row, { recipe: { digest: recipe.sha256, size: recipe.size }, r2Committed: false });
    delete row.r2Key;
    s.objects.delete(base.sha256);
  }
  const selected = Array.from({ length: changed }, (_, i) => path(files - 1 - i));
  const mainEdits = new Map();
  let main = base;
  const chain = [];
  for (let i = 0; i < distance; i++) {
    if (i) chain.push(main.sha256);
    mainEdits.set(path(i), (await blob(`main-${i}`)).sha256);
    if (i === distance - 1) for (const p of selected) mainEdits.set(p, (await blob(`main ${p}`)).sha256);
    main = await state([main], `main-${i}`, mainEdits);
  }
  const laneEdits = new Map();
  for (const [i, p] of selected.entries())
    laneEdits.set(conflict ? p : path(files - 1 - changed - i), (await blob(`lane ${p}`)).sha256);
  const lane = await state([base], 'lane', laneEdits);
  return { base, main, lane, selected, chain, generations, state, blob, laneEdits, mainEdits };
}

const source = pin => ({ object: pin, recipe: null });
export async function syncInput(s, h) {
  return s.json({
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: 'forge-native-sync-v1',
    work: { mode: 'sync', left: source(h.lane), right: source(h.main) },
    message: 'sync',
    at,
  });
}

/** The agent edits the conflicted paths in the draft and saves one child State to resolve. */
export async function resolveInput(s, h, output, text = p => `resolved ${p}`) {
  const draft = output.result.state,
    resolved = new Map([...h.mainEdits, ...h.laneEdits]);
  for (const p of h.selected) resolved.set(p, (await h.blob(text(p))).sha256);
  const saved = await h.state([draft], 'resolved', resolved);
  return s.json({
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: 'forge-native-sync-v1',
    work: {
      mode: 'resolve',
      left: {
        object: saved,
        recipe: (() => {
          const row = [...s.tables.projectObjects.values()].find(row => row.digest === saved.sha256);
          return row?.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null;
        })(),
      },
      resolution: {
        candidateId: null,
        conflicts: output.result.conflicts,
        left: output.result.left,
        right: output.result.right,
        draftHead: draft.sha256,
        status: 'pending',
      },
    },
    message: 'resolve',
    at,
  });
}

export async function measureSync({
  files,
  changed,
  distance,
  conflict,
  resolve = conflict,
  recipeBase = false,
  saveResolve = false,
}) {
  const s = await scaleFixture();
  try {
    const h = await syncHistory(s, { files, changed, distance, conflict, recipeBase });
    const eventStart = s.events.length,
      countStart = s.counts.length;
    const id = await s.enqueue(await syncInput(s, h)),
      sync = await s.drain({ memoryBound: false }).catch(error => {
        throw Object.assign(error, { phase: 'sync' });
      }),
      job = await s.job(id);
    assert.equal(job.status, 'completed', JSON.stringify(job.control?.failureCode));
    const outputBytes = await s.bytes(job.output),
      output = JSON.parse(outputBytes.toString());
    assert.equal(output.result.status, conflict ? 'conflict' : 'merged');
    const report = {
      files,
      changed,
      distance,
      conflict,
      sync: summary(s, id, sync, eventStart, countStart),
      output: digest(outputBytes),
      state: output.result.state.sha256,
    };
    if (resolve) {
      let saved;
      if (saveResolve) {
        const draft = output.result.state,
          parsed = JSON.parse((await s.bytes(draft)).toString()),
          entries = new Map(parsed.files.map(file => [file.path, file]));
        const changes = [];
        for (const path of h.selected) {
          const pin = await h.blob(`resolved ${path}`),
            before = entries.get(path);
          changes.push({
            path,
            before: { blob: before.blob, mode: before.mode },
            after: { blob: pin.sha256, mode: 'file', content: source(pin) },
          });
        }
        const pages = buildSavePages(changes);
        for (const page of pages.pages) await s.json(page.value);
        const row = [...s.tables.projectObjects.values()].find(row => row.digest === draft.sha256),
          plan = await s.json({
            schema: 1,
            kind: 'forge-hosted-save-input',
            baseline: {
              object: draft,
              recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
            },
            pages: pages.root,
            pageCount: pages.pages.length,
            changeCount: changes.length,
            message: 'resolved',
            at,
          });
        const start = s.events.length,
          counts = s.counts.length,
          saveId = await s.enqueue(plan),
          metrics = await s.drain({ memoryBound: false }),
          job = await s.job(saveId);
        assert.equal(job.status, 'completed');
        saved = JSON.parse((await s.bytes(job.output)).toString()).state;
        report.saveState = saved.sha256;
        report.save = summary(s, saveId, metrics, start, counts);
      }
      const input = await resolveInput(s, saved ? { ...h, state: async () => saved } : h, output);
      const resolveEvents = s.events.length,
        resolveCounts = s.counts.length;
      const resolveId = await s.enqueue(input),
        resolveRun = await s.drain({ memoryBound: false }),
        resolveJob = await s.job(resolveId);
      assert.equal(resolveJob.status, 'completed', JSON.stringify(resolveJob.control?.failureCode));
      const resolvedBytes = await s.bytes(resolveJob.output),
        resolvedOutput = JSON.parse(resolvedBytes.toString());
      report.resolvedOutput = digest(resolvedBytes);
      report.resolvedState = resolvedOutput.result.state.sha256;
      assert.equal(resolvedOutput.result.status, 'resolved');
      report.resolve = summary(s, resolveId, resolveRun, resolveEvents, resolveCounts);
    }
    report.manifestBytes = h.main.size;
    const idle = await s.drain({ memoryBound: false });
    assert.equal(idle.functionCalls, 0, 'a settled sync/resolve schedules no idle work');
    assert.equal(idle.readObjects, 0);
    report.idleCalls = idle.functionCalls;
    return report;
  } finally {
    s.restore();
  }
}
/** Source-job cost only: preparation, the CLI and final Lane publication are outside this fixture.
 * R2 bytes count attempted bodies (including 412 reuse), not provider-billed traffic. Clock kinds
 * overlap, so never subtract their sum from runMs and call that merge time. */
function summary(s, jobId, r, eventStart, countStart) {
  const events = s.events.slice(eventStart),
    counts = s.counts.slice(countStart),
    steps = [...s.tables.projectSourceSteps.values()]
      .filter(row => row.jobId === jobId)
      .flatMap(row => row.timing?.steps ?? []),
    puts = events.filter(event => event.put !== undefined),
    names = events.filter(event => event.call).map(event => event.call);
  return {
    wallMs: Math.round(r.wallMs),
    actionMs: Math.round(r.actionMs),
    workCpuMs: Math.round(r.workCpuMicros / 1000),
    steps: r.steps,
    functionCalls: r.functionCalls,
    documentsRead: r.documentsRead,
    documentsWritten: r.documentsWritten,
    dbReadBytes: counts.reduce((n, row) => n + row.readBytes, 0),
    dbWriteBytes: counts.reduce((n, row) => n + row.writeBytes, 0),
    readObjects: r.readObjects,
    readBytes: r.readBytes,
    outputBindings: events
      .filter(
        event =>
          event.call &&
          ['projectConvexSourceStore:commit', 'projectConvexSourceStore:stage'].includes(event.call),
      )
      .flatMap(event => event.args.objects ?? [])
      .reduce((count, object) => count + 1 + (object.physical?.length ?? 0), 0),
    headObjects: events.filter(event => event.head).length,
    putObjects: puts.length,
    putBytes: puts.reduce((n, event) => n + event.put, 0),
    reusedPutBytes: puts.filter(event => event.existed).reduce((n, event) => n + event.put, 0),
    descriptorCalls: names.filter(name => name === 'projectConvexSourceObjects:resolve').length,
    timing: steps,
    maxRssMB: Math.round(r.maxRssBytes / 2 ** 20),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [files = 29000, changed = 1, distance = 20] = process.argv.slice(2).map(Number);
  for (const conflict of [true, false])
    console.log(JSON.stringify(await measureSync({ files, changed, distance, conflict })));
}
