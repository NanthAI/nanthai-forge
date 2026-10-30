// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';

/** Only synthetic source, local person acceptance, and a scratch-only full gate.
 * This creates no hosted project, repository, check process or credential. */
export async function prepareDrillOwner(owner) {
  mkdirSync(owner, { recursive: true });
  writeFileSync(join(owner, 'q4.txt'), 'Q4 initial synthetic source\n');
  initNative(owner);
  const work = new WorkService(owner);
  const act = command => work.execute(command, work.store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Q4 synthetic initial main' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Q4 seed' });
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const main = act({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  });
  await work.dispatch(
    { action: 'set-policy', operationId: randomUUID(), acceptance: { mode: 'auto-on-pass', gate: 'full' } },
    work.store.revision(),
  );
  return { head: main.head, receiptId: main.id };
}
