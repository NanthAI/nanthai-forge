// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The bounded FYI read and its dismiss mutation.
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { FyiState } from './fyi';

export const fyiRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, string>(
  'projectNeedsFyi:read',
);
export const fyiDismiss = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; keys?: string[]; clearAll?: boolean; restore?: FyiState },
  string
>('projectNeedsFyi:dismiss');
