// SPDX-License-Identifier: Apache-2.0
import { agentActionSchema } from './agent-workflow-schema.js';
import { ForgeError } from './errors.js';

/** Describe invalid fields without echoing supplied values or unknown keys. */
export function parseAgentAction(input: unknown) {
  let normalized =
    input && typeof input === 'object' && 'action' in input && input.action === 'save'
      ? { ...input, action: 'checkpoint' }
      : input;
  if (
    normalized &&
    typeof normalized === 'object' &&
    'action' in normalized &&
    normalized.action === 'start' &&
    'intentId' in normalized &&
    typeof normalized.intentId === 'string' &&
    !('outcome' in normalized)
  )
    normalized = { ...normalized, outcome: `Continue Intent ${normalized.intentId}` };
  const parsed = agentActionSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(issue => {
    const path = issue.path.join('.') || 'action';
    if (issue.code === 'unrecognized_keys') return `${path}: unrecognized fields`;
    if (issue.code === 'invalid_union') return `${path}: does not match an accepted form`;
    if (issue.code === 'invalid_format' && issue.format === 'regex')
      return `${path}: use a full source digest (40 or 64 lowercase hexadecimal characters; review trees require 64)`;
    if (issue.code === 'invalid_value') return `${path}: choose a supported value (see action --help)`;
    return `${path}: ${issue.message}`;
  });
  throw new ForgeError(
    'BAD_ARGUMENT',
    `Invalid agent action. ${issues.join('; ')}. Use nforge agent ROOT ACTION --help.`,
  );
}
