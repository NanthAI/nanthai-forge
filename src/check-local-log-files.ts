// SPDX-License-Identifier: Apache-2.0
import { durableReplace } from './native-durability.js';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from './hash.js';
import { processAlive, processStartTime } from './local-process.js';
import { DAY_MS, LOCAL_LOG_DAYS } from './check-log-policy.js';
import { invariant } from './errors.js';
/** Hosted Mac runners keep full local pipes outside disposable source/runtime.
 * Event-driven pruning touches only completed, private run-log directories. */
export function localMacLogFiles(
  projectId: string,
  runId: string,
  root = process.env.FORGE_LOCAL_CHECK_LOG_DIR ?? join(tmpdir(), 'forge-mac-check-logs'),
  now = Date.now(),
) {
  invariant(/^[0-9a-f-]{36}$/i.test(runId), 'BAD_ARGUMENT', 'Use the exact local check run identity.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const base = realpathSync(root),
    info = lstatSync(root);
  invariant(
    !info.isSymbolicLink() && info.isDirectory() && (info.mode & 0o077) === 0,
    'UNSAFE_PATH',
    'Local check logs require a private directory.',
  );
  const project = join(base, digest(projectId));
  mkdirSync(project, { recursive: true, mode: 0o700 });
  invariant(realpathSync(project) === project, 'UNSAFE_PATH', 'Local log directory changed.');
  for (const name of readdirSync(project)) {
    if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
    const directory = join(project, name);
    try {
      if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) continue;
      const completed = join(directory, 'completed.json'),
        owner = join(directory, 'owner.json');
      let endedAt: number;
      if (existsSync(completed)) {
        if (lstatSync(completed).isSymbolicLink()) continue;
        endedAt = Date.parse(JSON.parse(readFileSync(completed, 'utf8')).endedAt);
      } else {
        if (lstatSync(owner).isSymbolicLink()) continue;
        const record = JSON.parse(readFileSync(owner, 'utf8'));
        endedAt = Date.parse(record.startedAt);
        for (const stream of ['stdout.log', 'stderr.log']) {
          const path = join(directory, stream);
          if (existsSync(path)) endedAt = Math.max(endedAt, lstatSync(path).mtimeMs);
        }
        if (
          !Number.isInteger(record.runner?.pid) ||
          (record.runner.startTime !== undefined && typeof record.runner.startTime !== 'string') ||
          record.runner.pid <= 0 ||
          processAlive(record.runner)
        )
          continue;
      }
      if (Number.isFinite(endedAt) && now - endedAt >= LOCAL_LOG_DAYS * DAY_MS)
        rmSync(directory, { recursive: true });
    } catch {
      /* Active, unverified and changing logs are preserved. */
    }
  }
  const directory = join(project, runId);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  invariant(realpathSync(directory) === directory, 'UNSAFE_PATH', 'Local run log directory changed.');
  durableReplace(
    join(directory, 'owner.json'),
    JSON.stringify({
      startedAt: new Date(now).toISOString(),
      runner: { pid: process.pid, startTime: processStartTime(process.pid) },
    }),
  );
  rmSync(join(directory, 'completed.json'), { force: true });
  return {
    directory,
    async *stream(source: AsyncIterable<Uint8Array>, stream: 'stdout' | 'stderr') {
      const path = join(directory, `${stream}.log`);
      if (existsSync(path)) {
        const info = lstatSync(path);
        invariant(
          info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
          'UNSAFE_PATH',
          'Local log path changed.',
        );
      } else writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
      for await (const bytes of source) {
        appendFileSync(path, bytes);
        yield bytes;
      }
    },
    complete() {
      durableReplace(
        join(directory, 'completed.json'),
        JSON.stringify({ endedAt: new Date().toISOString() }),
      );
    },
  };
}
