// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

export const ghFields = {
  pr: [
    'operationId',
    'id',
    'number',
    'laneId',
    'intentId',
    'title',
    'body',
    'state',
    'headRefName',
    'headRefOid',
    'baseRefName',
    'baseRefOid',
    'url',
    'path',
    'viewId',
    'statusCheckRollup',
  ],
  checks: ['id', 'name', 'state', 'bucket', 'startedAt', 'completedAt', 'link', 'viewId', 'head'],
  merge: ['laneId', 'operationId', 'complete', 'status', 'phase', 'acceptance', 'view', 'check', 'receipt'],
  diff: [
    'kind',
    'id',
    'base',
    'head',
    'reviewTree',
    'total',
    'selectedTotal',
    'offset',
    'more',
    'nextOffset',
    'truncated',
    'changes',
    'coverage',
    'limitations',
    'indexTree',
    'selection',
    'checkpointSource',
    'stagedChanges',
    'unstagedChanges',
    'untrackedFiles',
    'workingMatchesIndex',
  ],
  checkout: ['laneId', 'head', 'path'],
  repo: ['id', 'name', 'nameWithOwner', 'url', 'path', 'engine', 'defaultBranchRef'],
  auth: [
    'deployment',
    'host',
    'authenticated',
    'account',
    'source',
    'tokenSource',
    'hosts',
    'name',
    'scope',
    'expiresAt',
    'identity',
  ],
} as const;
export type GhKind = keyof typeof ghFields;
export type GhOptions = { values: Record<string, string>; positional: string[]; fields?: string[] };
export function parseGhOptions(args: string[], kind: GhKind, flags: string[] = []): GhOptions {
  const values: Record<string, string> = {},
    positional: string[] = [];
  let fields: string[] | undefined;
  const aliases: Record<string, string> = {
    '-R': '--repo',
    '-t': '--title',
    '-b': '--body',
    '-B': '--base',
    '-s': '--state',
  };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!,
      equal = raw.indexOf('='),
      name = aliases[raw] ?? (equal > 0 ? raw.slice(0, equal) : raw);
    if (!raw.startsWith('-')) {
      positional.push(raw);
      continue;
    }
    invariant(name === '--json' || flags.includes(name), 'UNSUPPORTED_FLAG', `Unsupported flag: ${name}`);
    let value = equal > 0 ? raw.slice(equal + 1) : undefined;
    if (name === '--json' && value === undefined && (!args[i + 1] || args[i + 1]!.startsWith('-'))) {
      fields = [...ghFields[kind]];
      continue;
    }
    value ??= args[++i];
    invariant(value !== undefined && !value.startsWith('--'), 'BAD_ARGUMENT', `Provide a value for ${name}.`);
    if (name === '--json') {
      fields = value.split(',');
      for (const field of fields)
        invariant(
          (ghFields[kind] as readonly string[]).includes(field),
          'UNKNOWN_JSON_FIELD',
          `Unknown JSON field: ${field}. Available: ${ghFields[kind].join(',')}`,
        );
    } else {
      invariant(values[name] === undefined, 'BAD_ARGUMENT', `Repeated flag: ${name}`);
      values[name] = value;
    }
  }
  return { values, positional, ...(fields ? { fields } : {}) };
}
export function projectGh(value: unknown, fields?: string[]): unknown {
  if (!fields) return value;
  if (Array.isArray(value)) return value.map(item => projectGh(item, fields));
  const object = value as Record<string, unknown>;
  return Object.fromEntries(fields.map(field => [field, object[field] ?? null]));
}
