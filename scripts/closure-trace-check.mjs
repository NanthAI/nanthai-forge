// SPDX-License-Identifier: Apache-2.0
// Drives the existing unauthenticated dispatch jobs on a pinned public mirror tree.
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserGroups, browserSelection, isBrowserTest } from './browser-test-policy.mjs';
import { runActionsCheck } from './github-actions-check.mjs';
import { partitionTests } from './test-shards.mjs';

const runPrefix = 'closure-trace-';

export function closureDispatch(event) {
  const id = event?.inputs?.runId;
  if (typeof id !== 'string' || !id.startsWith(runPrefix)) return null;
  const match = /^closure-trace-([a-z0-9]+)-([A-Za-z0-9_-]{43})$/.exec(id);
  if (!match || event.inputs.deployment) throw new Error('Invalid closure trace dispatch input.');
  const traceKey = match[2];
  // Validate the input before running a full check.
  createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: traceKey }, format: 'jwk' });
  const shards = JSON.parse(event.inputs.plan ?? '[]');
  if (!Array.isArray(shards) || !shards.length || !shards.every((shard, index) => shard === index))
    throw new Error('Closure trace requires a consecutive zero-based shard matrix.');
  return { traceKey, count: shards.length };
}

export function closurePlan(tests, count) {
  const selection = browserSelection(
    { scope: 'full', reason: 'Input closure experiment', tests },
    undefined,
    tests,
  );
  const groups = browserGroups(partitionTests(selection.tests, count), Boolean(selection.browser));
  if (groups.length !== count)
    throw new Error('Closure trace shard count exceeds the selected test inventory.');
  return { standard: true, selection, groups };
}

export function traceDispatchedCheck() {
  const dispatch = closureDispatch(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  if (!dispatch) return false;
  const { traceKey, count } = dispatch;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (sha !== process.env.GITHUB_SHA)
    throw new Error('Closure trace checkout changed from the dispatch SHA.');
  const tests = execFileSync('git', ['ls-files', '-z', 'tests'], { encoding: 'utf8' })
    .split('\0')
    .filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path))
    .sort();
  const plan = closurePlan(tests, count);
  const browser = plan.groups[Number(process.env.FORGE_ACTIONS_SHARD)]?.some(isBrowserTest);
  const work = mkdtempSync(join(tmpdir(), 'forge-closure-check-'));
  try {
    const path = join(work, 'plan.json');
    writeFileSync(path, JSON.stringify(plan));
    process.env.FORGE_ACTIONS_PLAN = path;
    if (browser) {
      execFileSync('npm', ['ci', '--ignore-scripts'], { stdio: 'inherit' });
      execFileSync('node', ['node_modules/playwright/cli.js', 'install', 'chromium'], { stdio: 'inherit' });
    }
    console.log(`Closure trace checkout: ${sha}; ${tests.length} files across ${count} test shards`);
    runActionsCheck(execFileSync, { install: !browser, coverage: false, traceKey });
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
