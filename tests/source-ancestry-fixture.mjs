// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { saveBytes } from '../dist/hosted-save.js';
import { parseNativeState } from '../dist/state/format.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { prepareMergeStep, computeMergeStep } from '../dist/hosted-source-step-merge.js';
import { meter } from '../dist/hosted-source-step-verify.js';
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';

export const at = '2026-01-01T00:00:00.000Z';
export function ancestryFixture({ generationMetadata = false } = {}) {
  const objects = new Map(),
    parents = {},
    generations = {},
    reads = [],
    describes = [],
    hints = [];
  const put = raw => {
    const bytes = Buffer.from(raw),
      pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value));
  const file = (path, text) => ({ path, mode: 'file', blob: put(text).sha256 });
  const state = (files, edges = [], message = '') => {
    const pin = json({ schema: 1, kind: 'forge-source-state', files, parents: edges, message, at });
    parents[pin.sha256] = edges;
    if (edges.every(id => generations[id]))
      generations[pin.sha256] = 1 + Math.max(0, ...edges.map(id => generations[id]));
    return pin.sha256;
  };
  const ref = id => {
    assert(objects.has(id), `unknown State ${id} must remain required`);
    return { object: { sha256: id, size: objects.get(id).length }, recipe: null };
  };
  const io = {
    ...(generationMetadata ? { stateGeneration: id => generations[id] } : {}),
    async describeBatch(ids) {
      assert(ids.length <= 100);
      describes.push([...ids]);
      return ids.map(ref);
    },
    async read(pin) {
      reads.push(pin.sha256);
      return (async function* () {
        yield objects.get(pin.sha256);
      })();
    },
    async upload(pin, stream) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      assert.deepEqual(put(Buffer.concat(parts)), pin);
    },
  };
  const plan = (main, heads, restoreBase) => {
    const entries = heads.map(head => ({
      laneId: randomUUID(),
      head,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: ref(head),
    }));
    const inputs = buildComposePages(entries),
      dependencies = buildComposePages([]);
    for (const page of [...inputs.pages, ...dependencies.pages]) json(page.value);
    const value = {
      schema: 1,
      kind: 'forge-hosted-compose-input',
      base: { head: main, receiptId: randomUUID() },
      main: ref(main),
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'merge',
      at,
      ...(restoreBase ? { restoreBases: { [entries[0].laneId]: ref(restoreBase) } } : {}),
    };
    return { ...initialSourceStep(json(value)), plan: value, phase: 'selection' };
  };
  const verifiedParents = () =>
    Object.fromEntries(
      Object.keys(parents).map(id => {
        const bytes = objects.get(id);
        assert.equal(digest(bytes), id);
        return [id, parseNativeState(bytes).parents];
      }),
    );
  const persist = async cursor => {
    const stored = new Map();
    const saved = await saveSourceProgress(cursor, null, async bytes => {
      const id = digest(bytes);
      stored.set(id, bytes);
      return id;
    });
    return (await loadSourceProgress(stored.get(saved.id), async id => stored.get(id))).cursor;
  };
  async function compose(initial, { complete = false, hintMode = 'absent' } = {}) {
    let cursor = structuredClone(initial),
      rounds = 0;
    const locations = new Map();
    const transport = {
      ...io,
      ...(hintMode === 'absent'
        ? {}
        : {
            async probeStates(roots, options) {
              if (options) {
                hints.push({ roots: [...roots], known: [...options.known], hintMode });
                const warmed =
                  hintMode === 'empty'
                    ? []
                    : hintMode === 'incomplete'
                      ? roots.slice(0, 1)
                      : [
                          ...new Set([...roots.flatMap(id => parents[id] ?? []), ...roots.toReversed()]),
                        ].filter(id => !options.known.includes(id));
                for (const id of warmed) locations.set(id, ref(id));
              }
              // Production hints warm descriptor locations only. Requested
              // frontier order and exact manifest reads stay authoritative.
              const missing = roots.filter(id => !locations.has(id));
              for (const value of await io.describeBatch(missing)) locations.set(value.object.sha256, value);
              return { refs: roots.map(id => locations.get(id)), unavailable: [] };
            },
          }),
    };
    const start = reads.length;
    while (cursor.phase !== 'compute') {
      assert(++rounds < 1000);
      await prepareMergeStep(cursor, transport, meter());
      cursor = await persist(cursor);
      if (complete && cursor.phase !== 'selection') {
        cursor.parents = verifiedParents();
        cursor.states = [];
        delete cursor.ancestryBoundary;
        cursor.phase = 'compute';
      }
    }
    const graphReads = reads.slice(start);
    while (cursor.phase !== 'done') {
      assert(++rounds < 1100);
      await computeMergeStep(cursor, io);
      cursor = await persist(cursor);
    }
    return {
      cursor,
      graphReads,
      output: objects.get(cursor.output.sha256),
      headBytes: cursor.head ? objects.get(cursor.head) : null,
    };
  }
  return {
    objects,
    parents,
    generations,
    reads,
    describes,
    hints,
    put,
    json,
    file,
    state,
    ref,
    plan,
    compose,
    verifiedParents,
  };
}
