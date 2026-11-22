// SPDX-License-Identifier: Apache-2.0
// Run as a child of a synchronous preflight: waits FIFO for a machine-wide `nforge heavy`
// slot held for the parent pid, prints it as JSON and exits. A preflight inside `nforge heavy`
// reuses the inherited slot instead. Keep the queue in this child so preflight can wait synchronously.
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { heavySlots, readClientSettings } from './client-settings.js';
import {
  acquireHeavySlot,
  heavySlotDirectory,
  inheritedHeavySlot,
  measuredHeavyAdmission,
  waitingMessage,
} from './heavy-slots.js';
import { canonicalRoot } from './root-paths.js';

const [holder, cwd] = [Number(process.argv[2]), process.argv[3] ?? process.cwd()];
const directory = heavySlotDirectory();
const slots = heavySlots(readClientSettings().localHeavySlots);
const inherited = inheritedHeavySlot(directory);
let waited = false;
const queuedAt = Date.now();
const claimed =
  inherited || slots === 0
    ? null
    : await acquireHeavySlot(
        directory,
        slots,
        wait => process.stderr.write(waitingMessage(slots, directory, wait)),
        {
          command: 'preflight',
          cwd,
          holder,
          onQueue: () => {
            waited = true;
          },
          // The same measured admission as nforge heavy (ff33e9a6): a preflight counts a full share.
          admission: await measuredHeavyAdmission(),
        },
      );
if (claimed)
  writeFileSync(
    join(claimed, 'holder.json'),
    JSON.stringify({ cwd, startedAt: Date.now(), command: 'preflight' }),
  );
// The lease subprocesses inherit, so their own `nforge heavy` calls reuse it.
const parent = inherited
  ? process.env.FORGE_HEAVY_PARENT
  : claimed && JSON.stringify({ directory: canonicalRoot(directory), slot: basename(claimed), pid: holder });
process.stdout.write(
  JSON.stringify({ slot: claimed, parent: parent || null, slots, waited, waitedMs: Date.now() - queuedAt }),
);
