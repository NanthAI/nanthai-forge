// SPDX-License-Identifier: Apache-2.0
// Settings > Agents as words (Item f2ee8381). Pure: the page supplies the one read of `agentGuidance.read`.
export type Guidance = { project: string; personal: string; projectEditable: boolean };
export type Scope = 'project' | 'personal';

/** The most the server keeps for one guidance text (src/agent-guidance-schema.ts). */
export const GUIDANCE_LIMIT = 4000;

/** The page sentence: what the texts do, then what the person may change here. */
export const sentence = (projectEditable: boolean) =>
  projectEditable
    ? 'Every agent’s Forge briefing includes the project guidance and the guidance of the person who started it.'
    : 'Every agent’s Forge briefing includes the project guidance. Only the owner or a guidance maintainer can change it.';

/** One save: the whole request is fixed on the first press and replayed verbatim until it succeeds. */
export type Attempt = { scope: Scope; text: string; operationId: string };

/** The attempt for this press: the unresolved one when the text is unchanged, otherwise a new one. */
export function attemptFor(previous: Attempt | null, scope: Scope, text: string): Attempt {
  return previous && previous.scope === scope && previous.text === text
    ? previous
    : { scope, text, operationId: crypto.randomUUID() };
}
