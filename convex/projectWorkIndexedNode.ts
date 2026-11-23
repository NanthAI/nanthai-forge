// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { hostedAcceptance } from './projectAcceptance';
import { readSourceReview } from './projectSourceReview';
import type { IndexedCommandHooks } from './projectWorkIndexedCommand';

/** The Node-only readers the runtime-neutral command needs for acceptance and anchored notes. */
export const nodeCommandHooks: IndexedCommandHooks = {
  acceptance: hostedAcceptance,
  sourceReview: readSourceReview,
};
