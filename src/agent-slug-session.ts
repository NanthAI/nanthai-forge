// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { slugFromDigest } from './agent-slug.js';
import { agentSessionKey } from './hosted-agent-journal.js';

/** The slug of one agent session id. Deterministic, so no state is kept for it. */
export const agentSlug = (session: string) =>
  slugFromDigest(createHash('sha256').update(`forge-agent-slug\u0000${session}`).digest('hex'));

/** This client's agent identity slug (Issue c29d0780), or undefined for a person acting directly.
 * The session is the agent client's own id (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, the MCP
 * session, or FORGE_AGENT_SESSION for other agent clients). `FORGE_HUMAN=1`, or no session id at
 * all, means a person: Forge then shows the plain `@handle`. Local and free: no call, no file. */
export function sessionAgentSlug(session?: string | null, env: NodeJS.ProcessEnv = process.env) {
  if (env.FORGE_HUMAN === '1' || session === null) return undefined;
  const declared = env.FORGE_AGENT_SESSION;
  const key = session ?? agentSessionKey(env) ?? (declared && declared.length <= 200 ? declared : undefined);
  return key ? agentSlug(key) : undefined;
}
