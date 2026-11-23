// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { AGENT_CLIENT } from '../src/agent-slug';
import { readAuthorship } from '../src/work-actor-types';

/** A missing declaration has a display label outside the model ID alphabet. */
export function authorshipLabel(value: Parameters<typeof readAuthorship>[0]) {
  const { app, model } = readAuthorship(value);
  const client = value.agentClient;
  const declared = client && AGENT_CLIENT.test(client) && client.includes(':');
  return { app: app ?? null, model: model === 'not-declared' && !declared ? 'model not declared' : model };
}
