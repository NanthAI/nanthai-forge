// SPDX-License-Identifier: Apache-2.0
import { linkSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { digest } from './hash.js';
import { callerReceiptKey } from './self-metric-receipt-key.js';
import type { CallerReceipt } from './self-metric-receipts.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { refuseRealUserState } from './test-isolation.js';

/** Pending receipts per deployment/project, shared by every CLI process of this user. The writer
 * loads no schema library: the first-write hook appends here on its answer path. */
const OUTBOX_LIMIT = 1000;
export function metricOutboxDirectory(address: Pick<HostedAgentAddress, 'url' | 'projectId'>) {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'forge', 'metric-outbox', digest(`${address.url}\0${address.projectId}`).slice(0, 32));
}
/** One exclusive-create file per idempotency key: replays never duplicate. Never throws. */
export function writeCallerReceipts(directory: string, receipts: CallerReceipt[]) {
  if (!receipts.length) return;
  try {
    refuseRealUserState(directory, 'the metric outbox');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (readdirSync(directory).filter(name => name.endsWith('.json')).length >= OUTBOX_LIMIT) return;
    for (const receipt of receipts) {
      // Complete bytes, then an exclusive link: readers never see a partial receipt.
      const temporary = join(directory, `${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      try {
        linkSync(
          temporary,
          join(directory, `${digest(callerReceiptKey(receipt, receipt.actor ?? '')).slice(0, 40)}.json`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        unlinkSync(temporary);
      }
    }
  } catch {
    process.emitWarning('Caller metric receipt could not be retained.', {
      code: 'METRIC_RECEIPT_UNAVAILABLE',
    });
  }
}
