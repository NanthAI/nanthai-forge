// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** The client sees only a history marker. Raw capsule bytes and object grants stay on the server. */
export const capsuleHistoryQueries = new Set([
  'projectHostedFinishObserve:page',
  'projectHostedLanding:status',
  'projectHostedLanding:attempts',
  'projectHostedLanding:candidate',
  'projectHostedFinish:inputs',
  'projectRecoveryHosted:page',
]);
export const journalPageQueries = new Set([
  'projectCoordination:feed',
  'projectCoordination:recent',
  'projectCoordinationReads:inbox',
  'projectCoordinationReads:related',
  'projectHostedProvenanceRead:read',
  'projectHostedRecordReads:read',
  'projectRecoveryHosted:page',
  'projectWorkIndex:records',
  'projectWorkStore:compare',
]);

export function journalPageProtocolRejected(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes('ArgumentValidationError') &&
    /extra field `?journalProtocol\b|journalProtocol.*\(extra field\)/.test(error.message)
  );
}

const legacyJournalQueries = new WeakMap<object, Set<string>>();
export async function queryJournalPage<T>(
  client: object,
  name: string,
  args: Record<string, unknown>,
  read: (input: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  let legacy = legacyJournalQueries.get(client);
  if (!journalPageQueries.has(name) || legacy?.has(name)) return read(args);
  try {
    return await read({ ...args, journalProtocol: 1 });
  } catch (error) {
    if (!journalPageProtocolRejected(error)) throw error;
    if (!legacy) legacyJournalQueries.set(client, (legacy = new Set()));
    legacy.add(name);
    return read(args);
  }
}

export const hasLandingCapsule = (value: unknown): boolean => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return !!parsed && typeof parsed === 'object' && 'landingCapsule' in parsed;
};
export async function hydrateLandingHistory(
  name: string,
  request: Record<string, unknown>,
  value: unknown,
  action: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  if (hasJournalHistory(value))
    return action(
      name.startsWith('projectCoordination')
        ? 'projectJournalCoordination:history'
        : 'projectJournalActions:history',
      { query: name, request: JSON.stringify(request) },
    );
  return capsuleHistoryQueries.has(name) && hasLandingCapsule(value)
    ? action('projectLandingCapsuleRead:history', { query: name, request: JSON.stringify(request) })
    : value;
}

export const hasJournalHistory = (value: unknown): boolean => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const marker = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  return (
    !!marker && typeof marker === 'object' && 'journalHistory' in marker && marker.journalHistory === true
  );
};
