// SPDX-License-Identifier: Apache-2.0
// Qualification only: run pinned source stages in one provider execution before changing
// publication or the CLI. The actual Convex transport, source kernel, storage and commit run.
// Each completed phase clears its tree cursor and byte cache before the next phase.
// The base bytes alone cross save -> sync; no parsed tree crosses a phase.
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
import { cachedReads } from '../dist/hosted-source-read-cache.js';
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';
import { digest } from '../dist/hash.js';
import { saveBytes, savePin } from '../dist/hosted-save.js';
import { logSourceStep } from '../dist/hosted-source-io-error.js';
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
const { sourceStorage } = await import(moduleUrl('../convex/projectConvexSourceStorage.ts'));
const reference = name => makeFunctionReference(name);

export const step = {
  async _handler(ctx, input) {
    const loaded = await ctx.runMutation(reference('projectConvexSourceStore:begin'), input);
    if (!loaded) return null;
    const state = JSON.parse(loaded);
    input = { ...input, generation: state.generation };
    const transport = convexSourceTransport(ctx, input, state.locations, undefined, {
      overlapWrites: true,
      hash: digest,
    });
    const { io, settle, outputs, clock, smallOutput } = transport;
    const durable = sourceStorage(ctx, input.projectId, digest, transport.putMetrics.observer('progress'));
    const read = async pin => {
      const parts = [];
      for await (const part of await io.read(pin)) parts.push(Buffer.from(part));
      const bytes = Buffer.concat(parts);
      assert.equal(bytes.length, pin.size);
      assert.equal(digest(bytes), pin.sha256);
      return JSON.parse(bytes.toString());
    };
    const plan = await read(state.input);
    assert.equal(plan.kind, 'forge-source-fusion-probe');
    assert.equal(plan.stages.length, 3);
    let next = 0,
      results = [],
      cursor = initialSourceStep(plan.stages[0]),
      progress = null;
    if (state.cursor) {
      const retained = JSON.parse(Buffer.from(await durable.read(state.cursor)).toString());
      next = retained.next;
      results = retained.results;
      const loaded = await loadSourceProgress(await durable.read(retained.cursor), durable.read);
      cursor = loaded.cursor;
      progress = loaded.value;
    }
    const cache = { bytes: new Map(), held: 0 };
    const cached = cachedReads(io, cache, 8 * 1024 * 1024);
    const phases = [];
    const started = performance.now();
    // A fixed three-stage proposal, no fan-out or unbounded loop. It retains the kernel's
    // per-quantum budgets and the provider's 20 s boundary, output window and step fencing.
    for (let quantum = 0; quantum < 12 && performance.now() - started < 20000; quantum++) {
      const result = await runSourceStep(cursor, cached);
      cursor = result.cursor;
      await settle();
      if (cursor.phase === 'done') {
        phases.push({
          stage: next,
          ...process.memoryUsage(),
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        });
        results.push({
          input: cursor.input,
          output: cursor.output,
          result: JSON.parse(smallOutput(cursor.output)),
        });
        // Do not keep a completed save's entire file list, inventory, parent map
        // or the large cursor clone alive while the next phase starts.
        cursor.files = [];
        cursor.changes = [];
        cursor.inventory = {};
        cursor.selections = [];
        cursor.parents = {};
        cursor.seen = {};
        // Save's already verified base is the only large buffer needed by sync.
        for (const [id, bytes] of cache.bytes)
          if (next !== 0 || id !== plan.base.sha256) {
            cache.bytes.delete(id);
            cache.held -= bytes.length;
          }
        if (++next === plan.stages.length) break;
        cursor = initialSourceStep(plan.stages[next]);
        progress = null;
      }
      if (outputs.length >= 100) break;
    }
    let saved = null,
      output = null,
      result;
    if (next === plan.stages.length) {
      result = saveBytes({
        schema: 1,
        kind: 'forge-source-fusion-probe-result',
        input: state.input,
        results,
        phases,
      });
      output = { sha256: digest(result), size: result.length };
      await io.upload(
        output,
        (async function* () {
          yield Buffer.from(result);
        })(),
      );
    } else {
      const inner = await saveSourceProgress(cursor, progress, durable.store);
      saved = await durable.store(Buffer.from(JSON.stringify({ next, results, cursor: inner.id })));
    }
    await settle();
    logSourceStep(input, {
      runtime: 'node',
      kind: 'register-state',
      from: 'input',
      to: output ? 'done' : 'compute',
      objects: transport.reads.objects,
      bytes: transport.reads.bytes,
      outputs: outputs.length,
      putBytes: transport.putMetrics.snapshot(output),
      started,
    });
    await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
      ...input,
      cursor: saved,
      objects: outputs,
      output,
      failure: null,
      timing: { ...clock.value(), phase: `pipeline:${next}`, stop: output ? 'done' : 'bytes' },
    });
    return null;
  },
};
