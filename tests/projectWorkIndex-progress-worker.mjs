// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { getFunctionName } from 'convex/server';
import assert from 'node:assert/strict';
import { progressFixture } from './projectWorkIndex-progress-fixture.mjs';
const [mode, path] = process.argv.slice(2);
const saved = mode === 'resume' ? deserialize(readFileSync(path)) : undefined;
const f = progressFixture(0.04, saved);
const prior = structuredClone([...f.s.tables.projectWorkGenerations.values()][0]);
let firstExpected;
const mutation = f.s.ctx.runMutation;
f.s.ctx.runMutation = async (ref, args) => {
  const step = getFunctionName(ref) === 'projectWorkIndexBuildStore:step';
  if (step && firstExpected === undefined) firstExpected = args.expected;
  const result = await mutation(ref, args);
  if (step && mode === 'kill' && f.metrics.steps === 3) {
    writeFileSync(path, serialize(f.snapshot()));
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
let result;
do {
  result = await f.drive();
} while (typeof result !== 'string');
assert.equal(firstExpected, prior.ensureCursor, 'first resumed write continues exactly at persisted cursor');
assert.equal(result, prior._id, 'resumes original generation');
const metadata = JSON.parse(f.s.tables.projectWorkGenerations.get(result).metadata);
assert.equal(metadata.counts.intents, f.data.intents.length);
assert.equal(metadata.counts.views, f.data.views.length);
assert.equal(metadata.counts.checkpoints, 112);
console.log(JSON.stringify({ savedSteps: prior.nextBatch, resumedSteps: f.metrics.steps, id: result }));
