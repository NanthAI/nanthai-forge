// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { importBoundRecords } from '../dist/hosted-record-import.js';
const [root, mode] = process.argv.slice(2);
if (!root || (mode !== undefined && mode !== '--apply' && mode !== '--dry-run')) {
  process.stderr.write(
    'Usage: node scripts/import-hosted-records.mjs BOUND_OWNER_ROOT [--dry-run|--apply]\n',
  );
  process.exitCode = 1;
} else {
  const result = await importBoundRecords(root, mode === '--apply');
  process.stdout.write(JSON.stringify(result) + '\n');
}
