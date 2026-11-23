// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';

export const connectedApp = v.union(
  v.literal('claude-code'),
  v.literal('codex'),
  v.literal('cursor'),
  v.literal('opencode'),
  v.literal('pi'),
);

export const connectedApps = v.array(connectedApp);
