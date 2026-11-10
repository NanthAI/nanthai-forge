// SPDX-License-Identifier: Apache-2.0
import budgetsFile from './speed-budgets.json' with { type: 'json' };
import { speedBudgetsSchema } from './landing-speed-alerts.js';

/** The one budget file (b7851c44), parsed once. Numbers, sources and reasons: docs/agents/speed-budgets.md. */
export const speedBudgets = speedBudgetsSchema.parse(budgetsFile);
