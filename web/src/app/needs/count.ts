// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from '../../../../convex/_generated/dataModel';
import { makeFunctionReference } from 'convex/server';
import type { NeedsRead } from '../../../../src/needs-attention';
export * from '../../../../src/needs-attention';

export const needsRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, NeedsRead>(
  'projectNeedsMe:read',
);
