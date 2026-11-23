// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { testReports } from './check-test-report.js';

/** Shared Actions collector and retained test-evidence contract. */
export type CheckExecutionEvent =
  | { kind: 'execution'; executionId: string; image: string; index?: number; attempt?: number }
  | {
      kind: 'result';
      pin: string;
      head: string;
      definition: string;
      exitCode: number;
      estimatedCostUsd: number;
      executions?: {
        executionId: string;
        index: number;
        attempt: number;
        exitCode?: number;
        infrastructure?: 'oom' | 'sandbox-stopped';
        tests?: ReturnType<typeof testReports>;
      }[];
      details?: string;
    };
