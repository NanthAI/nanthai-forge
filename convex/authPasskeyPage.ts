// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';

export const PASSKEY_PAGE_SIZE = 20;
export const passkeyPosition = v.object({ passkeyId: v.string(), createdAt: v.number() });
export const displayPasskey = v.object({
  ...passkeyPosition.fields,
  name: v.optional(v.string()),
});
export const firstPasskeyPage = v.object({
  page: v.array(displayPasskey),
  continueAfter: v.union(passkeyPosition, v.null()),
});
