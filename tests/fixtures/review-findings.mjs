// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Synthetic review evidence shared by the persistence, rendering and browser replays.
export const review = {
  kind: 'forge-review',
  version: 1,
  laneId: '00000000-0000-4000-8000-000000000001',
  base: 'a'.repeat(64),
  head: 'b'.repeat(64),
  findings: [
    {
      id: 'R1',
      severity: 'should',
      path: 'src/upgrade.ts',
      side: 'head',
      blob: 'c'.repeat(64),
      line: 42,
      claim: 'The removed option still appears in the upgrade example. Replace it with the current call.',
      origin: 'changed',
      outcome: 'open',
    },
    {
      id: 'R2',
      severity: 'nit',
      path: 'docs/upgrade.md',
      side: 'base',
      blob: 'd'.repeat(64),
      line: 7,
      claim: 'The old introductory example uses a different name.',
      origin: 'pre-existing',
      outcome: 'declined',
      reason: 'Outside this change; the existing follow-up owns the introduction.',
    },
  ],
};
