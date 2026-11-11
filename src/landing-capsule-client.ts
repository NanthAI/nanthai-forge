// SPDX-License-Identifier: Apache-2.0
/** The client sees only a history marker. Raw capsule bytes and object grants stay on the server. */
export const capsuleHistoryQueries = new Set([
  'projectHostedFinishObserve:page',
  'projectHostedLanding:status',
  'projectHostedLanding:attempts',
  'projectHostedLanding:candidate',
  'projectHostedFinish:inputs',
]);
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
  return capsuleHistoryQueries.has(name) && hasLandingCapsule(value)
    ? action('projectLandingCapsuleRead:history', { query: name, request: JSON.stringify(request) })
    : value;
}
