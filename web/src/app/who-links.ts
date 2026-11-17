// SPDX-License-Identifier: Apache-2.0
// Where "who did it" leads (Item 41514fee): a handle opens the person's page, a run name opens that run's page in the
// project the row belongs to. Pure: the ds Who takes these as props, so the design system never imports app addresses.
import { followLink } from './router';
import { hrefFor } from './paths';

export type WhoProject = { handle: string; project: string };

/** The links for one `@handle` or `handle/run` in this project (or none for a run when no project is known). */
export function whoLinks(handle: string, project?: WhoProject) {
  const slash = handle.indexOf('/');
  const person = (slash < 0 ? handle : handle.slice(0, slash)).replace(/^@/, '');
  const run = slash < 0 ? '' : handle.slice(slash + 1);
  return {
    personHref: person ? hrefFor({ frame: 'discover', page: 'profile', handle: person }) : undefined,
    runHref:
      run && project
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
