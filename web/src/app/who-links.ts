// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Where "who did it" leads (Item 41514fee): a handle opens the person's page, a run name opens that run's page in the
// project the row belongs to. Pure: the ds Who takes these as props, so the design system never imports app addresses.
import { AGENT_CLIENT, isAgentSlug } from '../../../src/agent-slug';
import { followLink } from './router';
import { hrefFor } from './paths';

export type WhoProject = { handle: string; project: string };

const publicHandle = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

/** Row reads already apply the project's identity visibility policy. Accept only public handle and run shapes. */
export function recordedIdentity(actor?: string | null, run?: string | null) {
  const [person, embedded, ...rest] = (actor ?? '').replace(/^@/, '').split('/');
  const label = person && publicHandle.test(person) && !rest.length ? person : '';
  const agent = run ?? embedded;
  if (isAgentSlug(agent)) return `${label}/${agent}`;
  return label ? `@${label}` : null;
}

export function declaredModel(client?: string | null) {
  return client && AGENT_CLIENT.test(client) ? (client.split(':')[1] ?? null) : null;
}

/** The links for one `@handle` or `handle/run` in this project (or none for a run when no project is known). */
export function whoLinks(handle: string, project?: WhoProject) {
  const slash = handle.indexOf('/');
  const person = (slash < 0 ? handle : handle.slice(0, slash)).replace(/^@/, '');
  const run = slash < 0 ? '' : handle.slice(slash + 1);
  return {
    personHref: person ? hrefFor({ frame: 'discover', page: 'profile', handle: person }) : undefined,
    runHref:
      person && run && project
        ? hrefFor({
            frame: 'project',
            handle: project.handle,
            project: project.project,
            place: 'lanes',
            section: 'sessions',
            rest: `${person}/${run}`,
          })
        : undefined,
    onFollow: followLink,
  };
}
