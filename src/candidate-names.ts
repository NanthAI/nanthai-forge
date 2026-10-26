// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Presentation aliases only. Persisted command identities and JSON keys stay unchanged. */
export const candidateActions: Readonly<Record<string, string>> = {
  view: 'candidate',
  views: 'candidates',
  'review-view': 'review-candidate',
  'compare-views': 'compare-candidates',
  'resolve-native-view': 'resolve-native-candidate',
};

export function canonicalCandidateAction(action: string): string {
  return Object.entries(candidateActions).find(([, candidate]) => candidate === action)?.[0] ?? action;
}

export function candidateCommand(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !('action' in input) || typeof input.action !== 'string')
    return input;
  const action = canonicalCandidateAction(input.action);
  return action === input.action ? input : { ...input, action };
}

/** Advertise both spellings to MCP clients; normalize before command identity is hashed. */
export function candidateActionSchema<T extends z.ZodObject>(schema: T, action: string) {
  const candidate = Object.hasOwn(candidateActions, action) ? candidateActions[action] : undefined;
  return candidate
    ? z.union([
        schema.extend({ action: z.literal(candidate) }),
        schema.describe(`Deprecated action ${action}; use ${candidate}.`),
      ])
    : schema;
}

/** One notice per CLI invocation, even when a command contains multiple aliases. */
let noticed = false;
export function noticeViewAlias(action: string): void {
  const candidate = Object.hasOwn(candidateActions, action) ? candidateActions[action] : undefined;
  if (!candidate || noticed) return;
  noticed = true;
  process.stderr.write(`Deprecated: ${action} is an alias for ${candidate}; use ${candidate}.\n`);
}
