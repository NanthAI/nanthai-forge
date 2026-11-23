// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const fmt = x =>
  Number.isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 3, useGrouping: false }) : '—';
export const table = (header, rows) =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
    '',
  ].join('\n');
