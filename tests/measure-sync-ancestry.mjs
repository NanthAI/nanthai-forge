// SPDX-License-Identifier: Apache-2.0
// Local real-handler/R2-fake measurement of a hosted Lane sync and its resolve when main is
// `distance` States ahead of the Lane's base (issue 1eef1b43). No network, no repository code.
// Usage: node tests/measure-sync-ancestry.mjs [files] [changed] [distance]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';

const path = i => `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`;

/** One shared base tree of `files` paths; main moves `distance` States (one path each, the last
 * also changes the `changed` selected paths); the Lane changes the same selected paths (a
 * conflict) or `changed` other paths (clean). Every State carries persisted generation metadata. */
export async function syncHistory(s, { files, changed, distance, conflict, recordParents = true }) {
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
      left: source(saved),
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

export async function measureSync({ files, changed, distance, conflict, resolve = conflict }) {
  const s = await scaleFixture();
  try {
    const h = await syncHistory(s, { files, changed, distance, conflict });
    const id = await s.enqueue(await syncInput(s, h)),
      sync = await s.drain({ memoryBound: false }).catch(error => {
        throw Object.assign(error, { phase: 'sync' });
      }),
      job = await s.job(id);
    assert.equal(job.status, 'completed', JSON.stringify(job.control?.failureCode));
    const outputBytes = await s.bytes(job.output),
      output = JSON.parse(outputBytes.toString());
    assert.equal(output.result.status, conflict ? 'conflict' : 'merged');
    const report = { files, changed, distance, conflict, sync: summary(sync), output: digest(outputBytes) };
    if (resolve) {
      const input = await resolveInput(s, h, output);
      const resolveId = await s.enqueue(input),
        resolveRun = await s.drain({ memoryBound: false }),
        resolveJob = await s.job(resolveId);
      assert.equal(resolveJob.status, 'completed', JSON.stringify(resolveJob.control?.failureCode));
      const resolvedBytes = await s.bytes(resolveJob.output),
        resolvedOutput = JSON.parse(resolvedBytes.toString());
      report.resolvedOutput = digest(resolvedBytes);
      assert.equal(resolvedOutput.result.status, 'resolved');
      report.resolve = summary(resolveRun);
    }
    report.manifestBytes = h.main.size;
    return report;
  } finally {
    s.restore();
  }
}
const summary = r => ({
  wallMs: Math.round(r.wallMs),
  actionMs: Math.round(r.actionMs),
  steps: r.steps,
  functionCalls: r.functionCalls,
  documentsRead: r.documentsRead,
  documentsWritten: r.documentsWritten,
  readObjects: r.readObjects,
  readBytes: r.readBytes,
  maxRssMB: Math.round(r.maxRssBytes / 2 ** 20),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [files = 29000, changed = 1, distance = 20] = process.argv.slice(2).map(Number);
  for (const conflict of [true, false])
    console.log(JSON.stringify(await measureSync({ files, changed, distance, conflict })));
}
