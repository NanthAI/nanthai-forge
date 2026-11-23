// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { WorkData, WorkView, ChannelMove } from './work-types.js';
/** Optional C1 selection metadata remains additive for existing Work writers. */
export function scopedPostAccept(data: WorkData, view: WorkView): ChannelMove['postAccept'] {
  const run = [...data.runs]
    .reverse()
    .find(run => run.viewId === view.id && run.head === view.head && run.status === 'passed');
  if (run && (view.optimistic || view.recovery?.phase === 'revert'))
    return { checkId: run.check.id, mode: 'full', reason: 'scoped-check' };
  if (run && data.landingBatches?.some(batch => batch.prefixes.some(prefix => prefix.viewId === view.id)))
    return { checkId: run.check.id, mode: 'full', reason: 'batch' };
  const selection = run && (run as typeof run & { checkSelection?: { scope: string } }).checkSelection;
  return run && selection && selection.scope !== 'full'
    ? { checkId: run.check.id, mode: 'full', reason: 'scoped-check' }
    : undefined;
}
