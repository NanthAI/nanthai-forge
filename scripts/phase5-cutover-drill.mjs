// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// No owner/account arguments: qualification always uses private synthetic fixtures.
import { sourceCutoverDrill } from '../tests/source-cutover-drill.mjs';
const cleanups = [];
try {
  if (process.argv.length !== 2) throw Error('Run without arguments; this drill only uses synthetic owners.');
  console.log(
    JSON.stringify(await sourceCutoverDrill({ after: cleanup => cleanups.push(cleanup) }), null, 2),
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
