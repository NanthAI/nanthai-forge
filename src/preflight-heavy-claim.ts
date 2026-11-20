// SPDX-License-Identifier: Apache-2.0
// Run as a child of a synchronous preflight (c180152a): waits FIFO for a machine-wide `nforge heavy`
// slot held for the parent pid, prints it as JSON and exits. A preflight inside `nforge heavy`
// reuses the inherited slot instead. Separate file so the queue code loads only when tests run.
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { heavySlots, readClientSettings } from './client-settings.js';
import { acquireHeavySlot, heavySlotDirectory, inheritedHeavySlot, waitingMessage } from './heavy-slots.js';
import { canonicalRoot } from './root-paths.js';

const [holder, cwd] = [Number(process.argv[2]), process.argv[3] ?? process.cwd()];
const directory = heavySlotDirectory();
const slots = heavySlots(readClientSettings().localHeavySlots);
const inherited = inheritedHeavySlot(directory);
const claimed =
  inherited || slots === 0
    ? null
    : await acquireHeavySlot(
        directory,
        slots,
        wait => process.stderr.write(waitingMessage(slots, directory, wait)),
        { command: 'preflight', cwd, holder },
      );
if (claimed)
  writeFileSync(
    join(claimed, 'holder.json'),
    JSON.stringify({ cwd, startedAt: Date.now(), command: 'preflight' }),
  );
// The lease the build and test processes inherit, so their own `nforge heavy` calls reuse it.
const parent = inherited
  ? process.env.FORGE_HEAVY_PARENT
  : claimed && JSON.stringify({ directory: canonicalRoot(directory), slot: basename(claimed), pid: holder });
process.stdout.write(JSON.stringify({ slot: claimed, parent: parent || null, slots }));
