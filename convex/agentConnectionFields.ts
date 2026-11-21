// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';

export const connectedApp = v.union(
  v.literal('claude-code'),
  v.literal('codex'),
  v.literal('cursor'),
  v.literal('opencode'),
  v.literal('pi'),
);

export const connectedApps = v.array(connectedApp);
