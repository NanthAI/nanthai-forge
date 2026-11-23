// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { expandUnreportedCounts } from '../dist/hosted-landing.js';

export function compactDiscardedChecks(t) {
  const name = 'FORGE_COMPACT_DISCARDED_CHECKS';
  const previous = process.env[name];
  process.env[name] = '1';
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

export function stampExecution(f, runId, seconds) {
  const row = [...f.tables.projectHostedCheckRuns.values()].find(row => row.runId === runId);
  const run = JSON.parse(row.value);
  f.patch('projectHostedCheckRuns', row._id, {
    value: JSON.stringify({ ...run, execution: { seconds, shards: run.plan.shardCount } }),
  });
}

/** Fixture inspection keeps physical row budgets separate from the logical ticket contract. */
export function ticketState(f, row) {
  const state = expandUnreportedCounts(JSON.parse(row.value));
  if (row.requestBodyId) {
    const body = JSON.parse(f.tables.projectHostedLandingBodies.get(row.requestBodyId).value);
    assert.equal(body.projectId, row.projectId);
    assert.equal(body.submissionId, row.submissionId);
    state.request = body.request;
  }
  // Item 8c50ce13: a stored message is part of the logical request.
  if (row.messageBodyId)
    state.request = {
      ...state.request,
      message: f.tables.projectHostedLandingBodies.get(row.messageBodyId).value,
    };
  return state;
}
export function patchTicketState(f, row, state) {
  const value = structuredClone(state);
  if (row.messageBodyId) delete value.request.message;
  if (row.requestBodyId) {
    const body = f.tables.projectHostedLandingBodies.get(row.requestBodyId);
    f.patch('projectHostedLandingBodies', body._id, {
      value: JSON.stringify({ ...JSON.parse(body.value), request: value.request }),
    });
    delete value.request;
  }
  f.patch('projectHostedLandingRequests', row._id, { value: JSON.stringify(value) });
}
/** Clone a synthetic ticket with fresh parent-owned bodies, never another ticket's pointers. */
export function seedTicket(f, input) {
  const row = { ...input },
    state = JSON.parse(row.value);
  for (const [pointer, field] of [
    ['requestBodyId', 'request'],
    ['selectionBodyId', 'batchSelection'],
  ]) {
    const source = row[pointer] && f.tables.projectHostedLandingBodies.get(row[pointer]);
    const content =
      field === 'request'
        ? (state.request ?? (source && JSON.parse(source.value).request))
        : (row.batchSelection ?? (source && JSON.parse(source.value).batchSelection));
    delete row[pointer];
    if (content !== undefined)
      row[pointer] = f.insert('projectHostedLandingBodies', {
        value: JSON.stringify({ projectId: row.projectId, submissionId: row.submissionId, [field]: content }),
      });
    if (field === 'request') delete state.request;
    else delete row.batchSelection;
  }
  row.value = JSON.stringify(state);
  return f.insert('projectHostedLandingRequests', row);
}

export function logicalTicket(f, row) {
  const result = { ...row, value: JSON.stringify(ticketState(f, row)) };
  if (row.selectionBodyId)
    result.batchSelection = JSON.parse(
      f.tables.projectHostedLandingBodies.get(row.selectionBodyId).value,
    ).batchSelection;
  return result;
}
/** Item 8c50ce13: accepted receipts in their logical inline form, whichever writer stored them:
 * a referenced message reads its body, and a cohort count lists the preceding members' messages. */
export function logicalReceipts(f) {
  const receipts = [...f.tables.projectHostedAcceptances.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(row => JSON.parse(row.value))
    .filter(receipt => receipt.synthetic === undefined);
  for (const receipt of receipts)
    if (receipt.messageRef) {
      receipt.message = f.tables.projectHostedLandingBodies.get(receipt.messageRef).value;
      delete receipt.messageRef;
    }
  for (const [index, receipt] of receipts.entries())
    if (receipt.cohortSize) {
      receipt.cohortMessages = receipts
        .slice(index + 1 - receipt.cohortSize, index + 1)
        .flatMap(member => (member.message === undefined ? [] : [member.message]));
      delete receipt.cohortSize;
    }
  return receipts;
}
