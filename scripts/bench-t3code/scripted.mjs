// SPDX-License-Identifier: Apache-2.0
// B1.5d no-model protocol/stress driver: dry edits exercise real coordination.
// A scenario role (scenarios.mjs) adds fixed moves; with no role the driver is the smoke run.
import { writeFileSync, chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { overlapClass } from './coordination.mjs';

/** Shared-file group of a task for dry runs ('' for disjoint tasks). */
export const dryGroup = task =>
  overlapClass(task.overlap).startsWith('disjoint')
    ? ''
    : overlapClass(task.overlap).replace(/[^a-z0-9]+/gi, '-');

export function scriptedForge(binDir) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const file of ['forge-protocol.mjs', 'scenarios.mjs'])
    copyFileSync(new URL(`./${file}`, import.meta.url), join(binDir, file));
  const driver = join(binDir, 'scripted-forge.mjs');
  writeFileSync(
    driver,
    `import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { driveForge, callForge } from './forge-protocol.mjs';
import { scenarioTest, scenarioTestPath, docEdit, landingReading, withdrawBody } from './scenarios.mjs';
const [task, defaultGroup, roleText] = process.argv.slice(2);
const role = roleText ? JSON.parse(roleText) : {};
const group = role.group ?? defaultGroup;
const log = event => console.log(JSON.stringify({ event: 'scenario', task, ...event, at: new Date().toISOString() }));
const laneId = JSON.parse(readFileSync('.forge/hosted-lane.json', 'utf8')).selection.laneId;
const message = 'bench dry run: ' + task;
if (role.releaseMs) {
  log({ step: 'release-wait', ms: role.releaseMs });
  await wait(role.releaseMs);
}
mkdirSync('.bench/dry', { recursive: true });
writeFileSync('.bench/dry/' + task + '.md', 'dry run ' + task + ' ' + new Date().toISOString() + '\\n');
if (group) appendFileSync('.bench/dry/group-' + group + '.md', task + '\\n');
const testPath = scenarioTestPath(task);
if (role.failOnce) writeFileSync(testPath, scenarioTest(task, 'fail'));
if (role.slowSeconds) writeFileSync(testPath, scenarioTest(task, 'slow', role.slowSeconds));
if (role.doc) writeFileSync(role.doc.path, docEdit(readFileSync(role.doc.path, 'utf8'), task, role.doc.at));
let fixed = false;
const onFailure = role.failOnce
  ? async () => {
      if (fixed) return false;
      fixed = true;
      log({ step: 'fix-after-failed-check' });
      writeFileSync(testPath, scenarioTest(task, 'fixed'));
      return true;
    }
  : null;
try {
  if (role.withdrawOnce) {
    // Submit without waiting, withdraw once the check is running, then land again.
    const submitted = await callForge({ root: process.cwd(), action: 'land', flags: ['--save', '--no-wait'], body: { laneId, message } });
    log({ step: 'submitted', error: submitted.error?.code ?? null });
    const operationId = submitted.operationId ?? submitted.result?.operationId ?? null;
    let reading = { submissionId: null, running: false, over: false };
    for (let i = 0; operationId && i < 60 && !reading.running && !reading.over; i++) {
      if (i) await wait(5_000);
      const reply = await callForge({ root: process.cwd(), action: 'landing', flags: [], body: { operationId } });
      const next = landingReading(reply);
      reading = { ...next, submissionId: next.submissionId ?? reading.submissionId };
    }
    log({ step: 'withdraw-at', running: reading.running, over: reading.over, bySubmission: Boolean(reading.submissionId) });
    const withdrawn = await callForge({ root: process.cwd(), action: 'land', flags: ['--withdraw'], body: withdrawBody(laneId, reading.submissionId, 'bench scenario withdraw-join') });
    log({ step: 'withdrawn', error: withdrawn.error?.code ?? null });
    await wait(role.relandAfterMs ?? 30_000);
  }
  const result = await driveForge({ root: process.cwd(), laneId, message, onFailure });
  if (process.env.BENCH_SCRIPTED_RESULT) writeFileSync(process.env.BENCH_SCRIPTED_RESULT, JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ event: 'product-friction', detail: error.message }));
  process.exitCode = 1;
}
`,
  );
  const file = join(binDir, 'scripted-forge.sh');
  writeFileSync(file, `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(driver)} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
