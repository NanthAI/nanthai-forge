// SPDX-License-Identifier: Apache-2.0
// Fixed workflow checkout supplies this executor; candidate scripts run as project code.
import { runActionsCheck } from './github-actions-check.mjs';
try {
  runActionsCheck();
} catch (error) {
  // A failed child already printed its own output; a guard error (ZERO_SELECTION, CHECK_CONTRACT_MISMATCH) has no status and must say why.
  if (error.status == null && !error.signal) console.error(error.message ?? error);
  process.exitCode = error.status ?? 1;
}
