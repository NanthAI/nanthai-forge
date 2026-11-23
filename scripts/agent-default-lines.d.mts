// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export type AgentDefaultValues = {
  preflight: 'off' | 'advise' | 'require';
  preflightMaxMinutes: number;
  urgentRoles: ('owner' | 'agents')[];
  checkpointNudgeMinutes: number;
  stallAlerts: {
    enabled: boolean;
    notifyAfterMinutes: number;
    repeatAfterMinutes: number;
    email: string[];
    webhook: 'off' | 'ntfy' | 'slack' | 'discord' | 'telegram' | 'generic';
  };
};
export const AGENT_DEFAULTS: Readonly<AgentDefaultValues>;
export function agentDefaultLines(defaults: AgentDefaultValues, root?: string): string[];
