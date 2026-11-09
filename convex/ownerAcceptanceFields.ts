// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
// Argument shape of the retired owner relay RPCs, kept so installed clients still reach CLI_UPGRADE_REQUIRED.
export const ownerMachine = v.object({
  ownerId: v.string(),
  name: v.string(),
  lastSeen: v.number(),
  mainHead: v.union(v.string(), v.null()),
  command: v.string(),
});
