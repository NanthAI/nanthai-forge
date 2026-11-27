// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

/** A standalone body without an operation is a record value. */
export function workEventRows(tables) {
  return [
    ...[...(tables.projectHostedRecordBodies?.values() ?? [])].filter(row => row.operationId !== undefined),
  ];
}
