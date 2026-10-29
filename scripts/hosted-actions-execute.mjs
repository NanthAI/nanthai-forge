// SPDX-License-Identifier: Apache-2.0
// Fixed workflow checkout supplies this executor; candidate scripts run as project code.
import { runActionsCheck } from './github-actions-check.mjs';
try {
  runActionsCheck();
} catch (error) {
  process.exitCode = error.status ?? 1;
}
