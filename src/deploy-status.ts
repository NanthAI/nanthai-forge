// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

export type DeployStatus = {
  target: string;
  label: string;
  environment: string;
  liveSequence: number | null;
  failure?: {
    key: string;
    since: string;
    sinceSequence: number;
    runUrl?: string;
    work?: { kind: 'lane' | 'item'; id: string; who: string };
    attentionAt?: number;
    attentionMinutes: number;
  };
};

export type DeployStatusRead = { mainSequence: number; targets: DeployStatus[] };
