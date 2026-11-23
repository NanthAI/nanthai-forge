// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import budgetsFile from './speed-budgets.json' with { type: 'json' };
import { speedBudgetsSchema } from './landing-speed-alerts.js';

/** The one budget file (b7851c44), parsed once. Numbers, sources and reasons: docs/agents/speed-budgets.md. */
export const speedBudgets = speedBudgetsSchema.parse(budgetsFile);
