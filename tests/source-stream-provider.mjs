// SPDX-License-Identifier: Apache-2.0
// Research adapter: production begin, R2 transport and commit, streaming sync compute only.
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { streamingSync } from './source-stream-sync.mjs';
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
const reference = name => makeFunctionReference(name);
export const step = {
  async _handler(ctx, args) {
    const loaded = await ctx.runMutation(reference('projectConvexSourceStore:begin'), args);
    if (!loaded) return null;
    const state = JSON.parse(loaded),
      input = { ...args, generation: state.generation };
    assert(!state.cursor, 'prototype does not implement resumable cursors');
    const { io, settle, outputs, smallOutput, clock } = convexSourceTransport(
      ctx,
      input,
      state.locations,
      undefined,
      { overlapWrites: true, hash: digest },
    );
    const parts = [];
    for await (const part of await io.read(state.input)) parts.push(part);
    const raw = Buffer.concat(parts);
    assert.equal(digest(raw), state.input.sha256);
    const output = await streamingSync(state.input, JSON.parse(raw), io);
    await settle();
    return ctx.runMutation(reference('projectConvexSourceStore:commit'), {
      ...input,
      cursor: null,
      objects: outputs,
      output,
      failure: null,
      result: smallOutput(output),
      timing: { ...clock.value(), phase: 'stream-sync', stop: 'done' },
    });
  },
};
