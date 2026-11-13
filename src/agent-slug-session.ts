// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { slugFromDigest } from './agent-slug.js';
import { resolveAgentSession } from './agent-session.js';

/** The slug of one agent session id. Deterministic, so no state is kept for it. */
export const agentSlug = (session: string) =>
  slugFromDigest(createHash('sha256').update(`forge-agent-slug\u0000${session}`).digest('hex'));

/** This client's run slug, selected from an explicit, native or opaque ancestor session.
 * FORGE_HUMAN forces a person. Local metadata only: no network call or state file. */
export function sessionAgentSlug(session?: string | null, env: NodeJS.ProcessEnv = process.env) {
  const key = resolveAgentSession(env, undefined, session)?.key;
  return key ? agentSlug(key) : undefined;
}
