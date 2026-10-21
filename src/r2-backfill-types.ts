// SPDX-License-Identifier: Apache-2.0
export const backfillKinds = ['objects', 'backups', 'proposals', 'archives'] as const;
export type BackfillPin = {
  kind: (typeof backfillKinds)[number];
  id: string;
  storageId: string;
  digest: string;
  size: number;
  location: 'r2' | 'convex' | null;
};
export type BackfillPage = {
  page: BackfillPin[];
  cursor: string;
  isDone: boolean;
  r2Writes: boolean;
  r2Revision: number;
};
export type BackfillCheck = {
  id: string;
  status: 'verified' | 'missing' | 'failed' | 'skipped';
  url: string | null;
};
export type BackfillTarget = {
  pin: BackfillPin;
  url: string;
  target: { url: string; headers: Record<string, string> };
};
export interface BackfillTransport {
  page(kind: BackfillPin['kind'], cursor: string | null, verify: boolean): Promise<BackfillPage>;
  targets(pins: BackfillPin[]): Promise<BackfillTarget[]>;
  check(pins: BackfillPin[], operationId: string, commit: boolean): Promise<BackfillCheck[]>;
}
export type BackfillState = {
  schema: 1;
  project: string;
  operationId: string;
  mode: 'run' | 'verify';
  startedAt: number;
  kind: number;
  cursor: string | null;
  count: number;
  bytes: number;
  samples: number;
  failures: { id: string; code: string }[];
  complete: boolean;
  verificationRevision?: number;
  verifiedAt?: string;
  safeToPurgeAfter?: string;
};
