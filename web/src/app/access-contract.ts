// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Shared screen contract (df06081d). Identity, credentials and presence are distinct.
 * Opaque ids are references, never proof of authority. Server access checks remain decisive. */
export type DeviceSettings = {
  source: 'write' | 'read' | 'coordination';
  projects: { kind: 'all' } | { kind: 'project'; projectId: string };
  /** Folder grant: writes only inside these folders (`dir/`) or files of the selected project. It ends
   * 7 days after its last write and at most 30 days after it was given; approving or saving gives it again. */
  paths?: string[];
};
export type DeviceIdentity = {
  id: string;
  code: string;
  approvedAt: number;
  /** Included only in the account owner's view under the device-name policy. */
  name?: string;
  settings: DeviceSettings;
};
export type DeviceSignIn = {
  credentialId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  state: 'signed-in' | 'signed-out' | 'expired' | 'removed';
};
export type LaneHolder = {
  sessionId: string;
  name: string;
  person: string;
  since: number;
};
export type HolderChange = {
  operationId: string;
  kind: 'resume' | 'take-back' | 'takeover' | 'handoff';
  at: number;
  by: string;
  previous: LaneHolder | null;
  current: LaneHolder;
  reason?: string;
  /** The pinned saved head is unchanged by a holder transition. */
  savedHead: string;
};
export type AgentPresence = {
  sessionId: string | null;
  name: string;
  person: string;
  device: Pick<DeviceIdentity, 'id' | 'code' | 'approvedAt' | 'name'> | null;
  app: string | null;
  identityFrom: 'app-thread' | 'declared' | 'process' | null;
  startedAt: number | null;
  lastSeen: number;
  lane: { id: string; title: string; holder: LaneHolder | null } | null;
};
