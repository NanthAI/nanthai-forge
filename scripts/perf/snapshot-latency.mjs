// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * What an unsaved-work snapshot adds to a Forge command (Issue 7ac4e32f): the time `launchSnapshotWorker`
 * holds the command, with no changed file, one, and fifty, in a real hosted Lane checkout of a scratch
 * project whose policy autoSnapshot is on. The walk and the uploads run in the detached worker, so this
 * is the command's whole cost; the worker's own time is reported as `durableAfterMs` (command start to
 * the new snapshot in the Lane's ledger). Writes only `snapshot-latency/` files inside the Lane checkout.
 */
export async function snapshotLatencySamples(laneRoot, count, distDirectory = '../../dist') {
  const dist = new URL(`${distDirectory}/`, import.meta.url);
  const { launchSnapshotWorker } = await import(new URL('hosted-snapshot-worker.js', dist));
  const { hostedAgentAddress } = await import(new URL('hosted-agent-address.js', dist));
  const { snapshotDirectory } = await import(new URL('lane-snapshot-hint.js', dist));
  const address = hostedAgentAddress(laneRoot, {});
  const directory = join(laneRoot, 'snapshot-latency');
  mkdirSync(directory, { recursive: true });
  const out = { unchanged: [], changed: [] };
  for (const [name, files] of [
    ['unchanged', 0],
    ['changed', 1],
    ['changed', 50],
  ])
    for (let n = 0; n < count; n++) {
      for (let file = 0; file < files; file++)
        writeFileSync(join(directory, `f${file}.txt`), `${randomUUID()}\n`.repeat(30));
      // Between two real commands the previous worker has finished and the burst gap has passed.
      await new Promise(done => setTimeout(done, files ? 4500 : 1500));
      const stamp = join(snapshotDirectory(laneRoot), 'worker');
      try {
        utimesSync(stamp, new Date(0), new Date(0));
      } catch {
        /* First launch: no stamp yet. */
      }
      const started = performance.now();
      launchSnapshotWorker(laneRoot, address);
      out[name].push({ durationMs: Math.round((performance.now() - started) * 10) / 10, files });
    }
  rmSync(directory, { recursive: true, force: true });
  return out;
}
