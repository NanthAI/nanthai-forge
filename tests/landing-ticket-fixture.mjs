// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
/** Fixture inspection keeps physical row budgets separate from the logical ticket contract. */
export function ticketState(f, row) {
  const state = JSON.parse(row.value);
  if (row.requestBodyId) {
    const body = JSON.parse(f.tables.projectHostedLandingBodies.get(row.requestBodyId).value);
    assert.equal(body.projectId, row.projectId);
    assert.equal(body.submissionId, row.submissionId);
    state.request = body.request;
  }
  return state;
}
export function patchTicketState(f, row, state) {
  const value = structuredClone(state);
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
