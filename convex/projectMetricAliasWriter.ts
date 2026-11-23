// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { metricAliasGeneration, metricContextKey, metricContextKeys } from '../src/self-metrics-context';

type Source = Parameters<typeof metricContextKeys>[0];
type Alias = Omit<Doc<'projectMetricFacts'>, '_id' | '_creationTime'>;
type Db = MutationCtx['db'];

export function metricAliasRows(
  projectId: Id<'hostedProjects'>,
  sourceId: string,
  source: Source,
  previous?: Source,
) {
  const oldKeys = previous ? metricContextKeys(previous) : null;
  return [...metricContextKeys(source)]
    .filter(key => !oldKeys?.has(key))
    .map(key => ({
      projectId,
      key: metricContextKey(metricAliasGeneration, key),
      sourceId,
      sourceCreatedAt: source.sourceCreatedAt,
      value: source.stream,
    }));
}

// Carries companion rows through the existing serialized projection port.
// The value object's identity is local to this invocation, never persisted.
const companions = new WeakMap<object, Alias[]>();
export function withMetricAliases<T extends object>(row: T, aliases: Alias[]): T {
  if (aliases.length) companions.set(row, aliases);
  return row;
}

export function writeWithMetricAliases<T>(db: Db, row: object, write: () => Promise<T>): Promise<T> {
  const aliases = companions.get(row);
  if (!aliases) return write();
  companions.delete(row);
  return Promise.all([write(), ...aliases.map(alias => db.insert('projectMetricFacts', alias))]).then(
    ([result]) => result,
  );
}
