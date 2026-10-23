// SPDX-License-Identifier: Apache-2.0
export const forgeSupportAddress = 'support@nanthai.tech';
export const forgeSupportPage = 'https://nanthai.tech/support';
export const requestTypes = {
  correction: 'Correction or attribution',
  claim: 'Upstream owner claim',
  optOut: 'Opt-out request',
  takedown: 'Takedown request',
  help: 'Forge support',
} as const;
export type PublicRequestSource = { repository: string; revision?: string };
export type RequestDraft = {
  schema: 1;
  kind: 'forge-upstream-request-draft';
  status: 'draft-not-submitted';
  id: string;
  createdAt: string;
  type: keyof typeof requestTypes;
  repository: string;
  revision: string;
  message: string;
};
// Only original explicitly public upstream identity can enter automatic prefilling.
// Account/session/source snippets and the current capability URL are never inputs.
export function publicRequestSource(status?: {
  gitHead?: string | null;
  hosted?: { upstream: string; visibility: string };
}): PublicRequestSource | undefined {
  if (status?.hosted?.visibility !== 'public') return undefined;
  let url: URL;
  try {
    url = new URL(status.hosted.upstream);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)
  )
    return undefined;
  return {
    repository: url.toString(),
    ...(status.gitHead && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(status.gitHead)
      ? { revision: status.gitHead }
      : {}),
  };
}
export function requestDraft(
  source?: PublicRequestSource,
  id = crypto.randomUUID(),
  at = new Date().toISOString(),
): RequestDraft {
  return {
    schema: 1,
    kind: 'forge-upstream-request-draft',
    status: 'draft-not-submitted',
    id,
    createdAt: at,
    type: source ? 'correction' : 'help',
    repository: source?.repository ?? '',
    revision: source?.revision ?? '',
    message: '',
  };
}
export function requestText(draft: RequestDraft) {
  return [
    'NanthAi Forge upstream/support request',
    `Correlation ID: ${draft.id}`,
    `Draft created: ${draft.createdAt}`,
    `Request: ${requestTypes[draft.type]}`,
    `Public upstream repository: ${draft.repository || 'Not supplied'}`,
    `Indexed Git revision: ${draft.revision || 'Not supplied'}`,
    '',
    draft.message,
    '',
    'This draft is a request and does not establish ownership, authorization or an operator decision. Please acknowledge receipt using the correlation ID.',
  ].join('\n');
}
export function requestMailto(draft: RequestDraft) {
  return `mailto:${forgeSupportAddress}?subject=${encodeURIComponent(`Forge ${requestTypes[draft.type]} — ${draft.id}`)}&body=${encodeURIComponent(requestText(draft))}`;
}
