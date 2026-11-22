// SPDX-License-Identifier: Apache-2.0
// Fixtures that model a busy, long-standing owner mark it Established in the account limiter
// (convex/accountLimits.ts, Item b6588425) without an account row, which many tests add themselves.
// An Established tier kept on a counter row carries over days, so the rows need no clock.
import { moduleUrl } from './convex-module.mjs';

const { ACCOUNT_LIMITS } = await import(moduleUrl('../convex/accountLimits.ts'));

export function establishedAccount(
  tables,
  subject = 'owner',
  channels = Object.keys(ACCOUNT_LIMITS.channels),
) {
  for (const channel of channels)
    for (let shard = 0; shard < ACCOUNT_LIMITS.channels[channel].shards; shard++) {
      const key = `limit:${channel}:${shard}:${subject}`;
      tables.deviceAttempts.set(key, {
        _id: key,
        _creationTime: 1,
        owner: key,
        windowAt: 0,
        count: 0,
        established: true,
      });
    }
}
