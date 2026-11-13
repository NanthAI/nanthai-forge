// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readProcess, type ProcessReader } from './agent-client-process.js';

/** Shell session declarations and executable basenames, not display names or account identity.
 * Keep support in one table; sources and coverage are in the workflow's agent-run section. */
export const AGENT_CLIENTS: readonly {
  harness: string;
  executables: readonly string[];
  sessionVariable: string | null;
}[] = [
  {
    harness: 'claude-code',
    executables: ['claude', 'claude-code'],
    sessionVariable: 'CLAUDE_CODE_SESSION_ID',
  },
  { harness: 'codex', executables: ['codex', 'codex-*'], sessionVariable: 'CODEX_THREAD_ID' },
  { harness: 'pi', executables: ['pi', 'pi-rpc', 'pi-coding-agent'], sessionVariable: 'PI_SESSION_ID' },
  { harness: 'opencode', executables: ['opencode'], sessionVariable: 'OPENCODE_SESSION_ID' },
  { harness: 't3-code', executables: ['t3', 't3 code'], sessionVariable: 'T3CODE_THREAD_ID' },
  { harness: 'cursor', executables: ['cursor-agent'], sessionVariable: null },
  { harness: 'gemini', executables: ['gemini'], sessionVariable: 'GEMINI_SESSION_ID' },
  { harness: 'copilot', executables: ['copilot'], sessionVariable: null },
  { harness: 'amp', executables: ['amp'], sessionVariable: null },
  { harness: 'aider', executables: ['aider'], sessionVariable: null },
  { harness: 'goose', executables: ['goose'], sessionVariable: null },
  { harness: 'droid', executables: ['droid'], sessionVariable: null },
  { harness: 'crush', executables: ['crush'], sessionVariable: 'CRUSH_SESSION_ID' },
  { harness: 'qwen-code', executables: ['qwen'], sessionVariable: 'QWEN_CODE_SESSION_ID' },
  { harness: 'cline', executables: ['cline'], sessionVariable: null },
  { harness: 'roo-code', executables: ['roo'], sessionVariable: null },
  { harness: 'kilo-code', executables: ['kilo'], sessionVariable: null },
  { harness: 'other', executables: ['agent', '*-coding-agent'], sessionVariable: null },
];
export type AgentAncestor = { harness: string; sessionVariable: string | null; pid: number; started: string };
const matches = (name: string, pattern: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(name);

/** Only executable names and kernel process identity; no arguments, environment or source reads.
 * Unrecognised intermediaries (including orchestrators' Node relays) do not select a parent id. */
export function nearestAgentProcess(
  read: ProcessReader = readProcess,
  from = process.ppid,
): AgentAncestor | null {
  const seen = new Set<number>();
  for (let depth = 0, pid = from; depth < 32 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const info = read(pid);
    if (!info) break;
    const name = info.command
      .split(/[\\/]/)
      .at(-1)!
      .toLowerCase()
      .replace(/\.exe$/, '');
    const client = AGENT_CLIENTS.find(row => row.executables.some(pattern => matches(name, pattern)));
    if (client)
      return { harness: client.harness, sessionVariable: client.sessionVariable, pid, started: info.started };
    pid = info.ppid;
  }
  return null;
}
let detected: AgentAncestor | null | undefined;
const localAncestor = () => (detected === undefined ? (detected = nearestAgentProcess()) : detected);
const valid = (value: string | undefined) => (value && value.length <= 200 ? value : undefined);
const opaque = (kind: string, value: string) =>
  `${kind}:${createHash('sha256').update(`forge-agent-${kind}\u0000${value}`).digest('hex')}`;

/** Explicit declarations win. Otherwise the closest agent owns the session; an inherited
 * outer client's variable never substitutes for that agent's missing session declaration.
 * An explicit environment describes a separate context; callers can supply its ancestry too. */
export function resolveAgentSession(
  env: NodeJS.ProcessEnv = process.env,
  ancestor?: AgentAncestor | null,
  session?: string | null,
): { key: string; harness?: string } | undefined {
  if (env.FORGE_HUMAN === '1') return undefined;
  const explicit = valid(env.FORGE_AGENT_SESSION);
  if (explicit) {
    const known = AGENT_CLIENTS.filter(
      client => client.sessionVariable && valid(env[client.sessionVariable]),
    );
    if (!known.length) return { key: explicit };
    const agent = ancestor === undefined ? (env === process.env ? localAncestor() : null) : ancestor;
    const harness = agent
      ? known.find(client => client.harness === agent.harness)?.harness
      : known.length === 1
        ? known[0]!.harness
        : undefined;
    return { key: explicit, ...(harness ? { harness } : {}) };
  }
  if (session !== undefined) return session === null ? undefined : { key: session };
  const agent = ancestor === undefined ? (env === process.env ? localAncestor() : null) : ancestor;
  if (agent) {
    const session = agent.sessionVariable ? valid(env[agent.sessionVariable]) : undefined;
    return {
      key: session ?? opaque('process', JSON.stringify([agent.pid, agent.started])),
      harness: agent.harness,
    };
  }
  const declared = AGENT_CLIENTS.flatMap(client => {
    const value = client.sessionVariable ? valid(env[client.sessionVariable]) : undefined;
    return value ? [{ key: value, harness: client.harness, variable: client.sessionVariable }] : [];
  });
  if (declared.length === 1) return declared[0];
  // Unavailable ancestry cannot establish which declaration is local. Preserve all of
  // them in an opaque key rather than guessing a parent by a fixed client precedence.
  if (declared.length > 1)
    return {
      key: opaque('sessions', JSON.stringify(declared.map(item => [item.variable, item.key]).sort())),
    };
  return undefined;
}
