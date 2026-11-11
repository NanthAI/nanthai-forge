// SPDX-License-Identifier: Apache-2.0
// MB is decimal throughout the spike contract; MiB is shown separately.
export const killBytes = 100_000_000;
export function isolateBytes(sample) {
  const fields = ['usedSize', 'embedderHeapUsedSize', 'backingStorageSize'];
  for (const field of fields)
    if (!Number.isFinite(sample[field]) || sample[field] < 0)
      throw Error(`Missing or invalid isolate memory field: ${field}`);
  // totalSize is allocated capacity, not used memory. Never add it to usedSize.
  return fields.reduce((sum, field) => sum + sample[field], 0);
}
export function decision({ count, samples, expected, output }) {
  if (expected && output && (expected.sha256 !== output.sha256 || expected.size !== output.size))
    return 'kill: differing output pin';
  if (count === 29000 && samples.some(sample => isolateBytes(sample) > killBytes))
    return 'kill: 29k isolate observation exceeds 100 MB';
  return 'unproven: checkpoint samples cannot establish the true peak';
}
// Source-step subtotal only. The future Worker's Convex control plane is not implemented:
// retain baseline calls/DB I/O as an explicit assumption, and expose bridge action cost.
export function costModel(baseline, worker, bridgeComputeDollars = 0) {
  const r2 = r => (r.put * 4.5 + (r.get + r.head) * 0.36) / 1000;
  const control =
    baseline.report.functionCalls * 0.002 + ((baseline.dbReadBytes + baseline.dbWriteBytes) / 1e6) * 0.2;
  return {
    professionalPer1000: {
      baseline:
        control +
        r2(baseline.r2) +
        (baseline.r2.putBytes / 1e6) * 0.12 +
        (baseline.report.actionMs / 3600000) * 0.5 * 1000 * 0.3,
      workerOptimistic: control + r2(worker.r2) + bridgeComputeDollars,
      workerBridgeComputeDollars: bridgeComputeDollars,
    },
    r2Per1000: { baseline: r2(baseline.r2), worker: r2(worker.r2) },
    r2UploadStoragePer1000Month: {
      baseline: (baseline.r2.putBytes / 1e6) * 0.015,
      worker: (worker.r2.putBytes / 1e6) * 0.015,
    },
  };
}
