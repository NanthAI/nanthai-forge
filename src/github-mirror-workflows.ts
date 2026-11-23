// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Runtime-neutral helpers for the mirror's workflows permission (Item a08b0d3a): the shared token
// module imports these, so they must not pull the Node mirror engine into default-runtime Convex.
import type { MirrorPlan } from './hosted-github-mirror.js';
export const workflowPath = (path: string) => path.startsWith('.github/workflows/');
/** True when the step moves GitHub main across commits other than its own (a burst tip). */
export const movesMainAcross = (plan: Pick<MirrorPlan, 'seed' | 'parent'>) =>
  !plan.seed.branch &&
  plan.seed.main?.publish !== false &&
  !!plan.seed.main?.expectedRef &&
  plan.seed.main.expectedRef !== plan.parent;
/** The plan's own changed or removed paths touch .github/workflows/. */
export const planTouchesWorkflows = (plan: { changes: { path: string }[]; pending: { path: string }[] }) =>
  plan.changes.some(file => workflowPath(file.path)) || plan.pending.some(file => workflowPath(file.path));
