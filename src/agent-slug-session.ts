// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readProcess } from './agent-client-process.js';
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

/** Public session reference and declared provenance. Native values and process identity stay local. */
export function sessionAgentIdentity(session?: string | null, env: NodeJS.ProcessEnv = process.env) {
  const resolved = resolveAgentSession(env, undefined, session);
  const parent = resolved ? null : readProcess(process.ppid);
  const key = resolved?.key ?? `human:${process.ppid}:${parent?.started ?? process.pid}`;
  const derivation: 'app-thread' | 'declared' | 'process' | null = !resolved
    ? null
    : env.FORGE_AGENT_SESSION
      ? 'declared'
      : resolved.key.startsWith('process:') || session !== undefined
        ? 'process'
        : resolved.harness
          ? 'app-thread'
          : 'declared';
  return {
    sessionId: createHash('sha256').update(`forge-holder-session\0${key}`).digest('hex'),
    name: resolved ? agentSlug(key) : null,
    app: resolved?.harness ?? null,
    derivation,
  };
}
