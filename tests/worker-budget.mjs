// SPDX-License-Identifier: Apache-2.0
import { availableParallelism } from 'node:os';

// Concurrent standard checks share the machine; mirror the check queue's default slot count.
export function checkSlots(env = process.env, cpus = availableParallelism()) {
  const configured = env.FORGE_MAX_CONCURRENT_CHECKS;
  return configured !== undefined && /^[1-9]\d*$/.test(configured) && Number.isSafeInteger(Number(configured))
    ? Number(configured)
    : Math.max(1, Math.floor(cpus / 4));
}

// Bound overlapping suites as well as each suite's own CPU/memory footprint: the
// headroom of all-but-two CPUs is divided across concurrent check slots.
export function workerBudget(env = process.env, cpus = availableParallelism()) {
  const configured = env.FORGE_TEST_WORKERS;
  if (configured !== undefined && !/^[1-9]\d*$/.test(configured))
    throw new Error('FORGE_TEST_WORKERS must be a positive integer.');
  const budget =
    configured === undefined
      ? Math.min(Math.max(1, Math.floor((cpus - 2) / checkSlots(env, cpus))), 8)
      : Number(configured);
  if (!Number.isSafeInteger(budget)) throw new Error('FORGE_TEST_WORKERS must be a safe integer.');
  return budget;
}
