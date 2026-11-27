// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

/** Both physical indexes are live during relocation. A standalone body without an operation is a record value. */
export function workEventRows(tables) {
  return [
    ...tables.projectWorkEvents.values(),
    ...[...(tables.projectHostedRecordBodies?.values() ?? [])].filter(row => row.operationId !== undefined),
  ];
}
