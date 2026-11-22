// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { takeCoverage } from 'node:v8';
import {
  executedCoreOffsets,
  executedCorePaths,
  replayTitle,
  runReplayCoverage,
  staleReplayPaths,
} from '../scripts/incident-replay-coverage.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

export function watchIncidentReplays(entries, output, confirmInIsolation = false) {
  const replays = entries.map(entry => ({ entry, title: replayTitle(entry.test), reached: new Set() }));
  // A queue proof refresh also records which functions ran (Item ec229a55).
  const scopeOutput = output && process.env.FORGE_REPLAY_SCOPE_OUTPUT;
  const offsets = new Map();
  const previousCoverage = process.env.NODE_V8_COVERAGE || undefined;
  const session = previousCoverage ? undefined : new Session();
  session?.connect();
  const profile = (method, params = {}) => {
    let reply;
    session.post(`Profiler.${method}`, params, (error, result) => {
      if (error) throw error;
      reply = result;
    });
    return reply;
  };
  if (session) profile('enable');

  let active;
  beforeEach(t => {
    const matches = replays.filter(replay => replay.title.test(t.name));
    if (!matches.length) return;
    if (active) {
      if (t.fullName.startsWith(active.t.fullName + ' > ')) return;
      throw new Error(`Overlapping incident replays: "${active.t.fullName}" and "${t.fullName}"`);
    }
    const directory = previousCoverage ?? temporaryDirectory(t, 'forge-replay-coverage-');
    // Preserve the native runner's full-file evidence by taking snapshots around
    // the replay instead of resetting its V8 counters through the inspector.
    if (previousCoverage) takeCoverage();
    const capture = { t, matches, directory, before: new Set(readdirSync(directory)), deferred: false };
    active = capture;
    for (const method of ['skip', 'todo']) {
      const original = t[method].bind(t);
      t[method] = (...args) => {
        capture.deferred = true;
        return original(...args);
      };
    }
    process.env.NODE_V8_COVERAGE = directory;
    process.env.FORGE_REPLAY_COVERAGE_CHILD = '1';
    if (session) profile('startPreciseCoverage', { callCount: true, detailed: false });
  });
  afterEach(t => {
    if (active?.t !== t) return;
    const { directory, before, matches, deferred } = active;
    active = undefined;
    if (previousCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = previousCoverage;
    delete process.env.FORGE_REPLAY_COVERAGE_CHILD;
    let reached;
    if (session) {
      const { result } = profile('takePreciseCoverage');
      profile('stopPreciseCoverage');
      reached = executedCorePaths(result);
      if (scopeOutput && !deferred && t.passed) executedCoreOffsets(result, offsets);
    } else {
      takeCoverage();
      reached = new Set();
    }
    // Some normal-suite replays assert on a nested Node run, including mutant failures.
    for (const name of readdirSync(directory)) {
      if (!/^coverage-.+\.json$/.test(name) || before.has(name)) continue;
      const scripts = JSON.parse(readFileSync(join(directory, name), 'utf8')).result;
      for (const path of executedCorePaths(scripts)) reached.add(path);
      if (scopeOutput && !deferred && t.passed) executedCoreOffsets(scripts, offsets);
    }
    if (!previousCoverage) rmSync(directory, { recursive: true, force: true });
    for (const replay of matches) {
      if (deferred) replay.deferred = true;
      if (deferred || !t.passed) continue;
      replay.ran = true;
      for (const path of reached) replay.reached.add(path);
    }
  });
  // The file can contain filtered-out tests. Finalize after every hook for the
  // tests that ran, and let the Node supervisor fail the file for stale proof.
  process.once('beforeExit', () => {
    session?.disconnect();
    const filtered = process.execArgv.some(arg =>
      /^--test-(?:name-pattern|skip-pattern|only)(?:=|$)/.test(arg),
    );
    for (const { entry, reached, ran, deferred } of replays) {
      if (output) {
        if (ran) writeFileSync(output, JSON.stringify([...reached].sort()) + '\n');
        if (ran && scopeOutput)
          writeFileSync(
            scopeOutput,
            JSON.stringify(
              Object.fromEntries([...offsets].map(([url, set]) => [url, [...set].sort((a, b) => a - b)])),
            ),
          );
        continue;
      }
      if (deferred) {
        process.stderr.write(`${entry.file}: replay "${entry.test}" skipped or marked TODO\n`);
        process.exitCode = 1;
        continue;
      }
      // A name filter can select just one variant of a parameterized replay.
      if (filtered && (!ran || entry.test.includes('${'))) continue;
      let stale = staleReplayPaths(entry.paths, reached);
      if (!stale.length) continue;
      // A previous test can cache a shared fixture or child process. Confirm a
      // miss under the same isolated execution that produced the registry.
      if (confirmInIsolation && !filtered && ran) {
        try {
          stale = staleReplayPaths(stale, new Set(runReplayCoverage(entry)));
        } catch (error) {
          process.stderr.write(`${error.message}\n`);
        }
      }
      if (!stale.length) continue;
      process.stderr.write(`${entry.file}: replay "${entry.test}" no longer reaches ${stale.join(', ')}\n`);
      process.exitCode = 1;
    }
  });
}
