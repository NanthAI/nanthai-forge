// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

// A task starts before its client: Lane preparation and relayed CLI calls must use
// the same opaque session, never the enclosing agent that launched the benchmark.
export const taskIdentity = () => ({ FORGE_AGENT_SESSION: randomUUID() });

export function withTaskIdentity(inherited, assigned) {
  const env = { ...inherited };
  for (const key of [
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_THREAD_ID',
    'FORGE_AGENT_SESSION',
    'FORGE_HUMAN',
    'FORGE_AGENT_MODEL',
  ])
    delete env[key];
  return { ...env, ...assigned };
}
