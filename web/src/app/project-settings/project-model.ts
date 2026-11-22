// SPDX-License-Identifier: Apache-2.0
// Settings > Project as words (Item 966cb821): what the page says about the project and what the owner may change.
// Pure: the page supplies the one read of the project and the viewer's handle.
export type ProjectFacts = {
  name: string;
  slug: string | undefined;
  handle: string;
  visibility: 'public' | 'private';
  createdAt: number;
  revision: number;
  removal: string | undefined;
};

/** Slugs: lowercase letters, numbers and hyphens, at most 100 characters (convex/projectLifecycle.ts). */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 100;

export const createdWords = (at: number) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
export const visibilityWords = (visibility: ProjectFacts['visibility']) =>
  visibility === 'public' ? 'Public' : 'Private';

/** The page sentence: one fact, then what the person may do here. */
export function sentence(facts: ProjectFacts, owner: boolean) {
  return owner
    ? `${visibilityWords(facts.visibility)} project. You own it, so you can rename it or move it to the trash.`
    : `${visibilityWords(facts.visibility)} project owned by @${facts.handle}. Only the owner can rename it or move it to the trash.`;
}

/** Why the rename form may not be saved, or null when it may. */
export function renameProblem(name: string, slug: string, facts: ProjectFacts) {
  if (!name.trim()) return 'Enter a project name.';
  if (!SLUG.test(slug)) return 'Use lowercase letters, numbers and hyphens in the address.';
  if (slug.length > SLUG_MAX) return `Use at most ${SLUG_MAX} characters in the address.`;
  if (name.trim() === facts.name && slug === facts.slug) return 'Nothing changed.';
  return null;
}
