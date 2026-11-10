// SPDX-License-Identifier: Apache-2.0
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
