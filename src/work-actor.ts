// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { userInfo } from 'node:os';
import { workActorSchema, type WorkActor } from './work-actor-types.js';
export { workActorSchema, type WorkActor } from './work-actor-types.js';
/** Local attribution is a declaration, never hosted identity or authority. */
export function localActor(kind: WorkActor['kind'], name?: string, tool?: string): WorkActor {
  return workActorSchema.parse({
    kind,
    name:
      name ??
      (kind === 'agent'
        ? (process.env.FORGE_AGENT_NAME ?? process.env.FORGE_ACTOR ?? 'Agent workflow')
        : userInfo().username),
    ...(kind === 'agent' && (tool ?? process.env.FORGE_ACTOR_TOOL)
      ? { tool: tool ?? process.env.FORGE_ACTOR_TOOL }
      : {}),
  });
}
