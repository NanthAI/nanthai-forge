// SPDX-License-Identifier: Apache-2.0
export type AgentDefaultValues = {
  preflight: 'off' | 'advise' | 'require';
  preflightMaxMinutes: number;
  urgentRoles: ('owner' | 'agents')[];
  overlapGate: 'off' | 'warn' | 'block';
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
