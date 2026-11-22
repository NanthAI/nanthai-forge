// SPDX-License-Identifier: Apache-2.0
// Settings > Project (Item 966cb821): the project's facts, rename, and Move to trash. One read of the project per page
// open (a one-off query, read again after a rename); each action is one retry-safe mutation; nothing runs while idle.
// Trash and restore live in Account > Projects (SPEC-01-trash): a trashed project is closed to everyone.
import { useCallback, useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { crumbsFor, Head } from '../Place';
import { hrefFor } from '../paths';
import { navigate } from '../router';
import type { PlaceProps } from '../screen-route';
import { trashHref } from '../projects/AccountStrip';
import { useLifecycle } from '../trash/lifecycle';
import Backups from './Backups';
import Imports from './Imports';
import { ProjectSettingsView } from './ProjectSettingsView';
import type { ProjectFacts } from './project-model';

export default function ProjectSettings(props: PlaceProps) {
  const { projectId, route, projectName, feed, viewerHandle } = props;
  const client = useConvex();
  const run = useLifecycle();
  const [facts, setFacts] = useState<ProjectFacts | null>(null);
  const [failed, setFailed] = useState(false);
  const read = useCallback(() => {
    void client
      .query(api.projectWork.state, { projectId })
      .then(project => {
        setFacts({
          name: project.name,
          slug: project.slug,
          handle: route.handle,
          visibility: project.visibility === 'public' ? 'public' : 'private',
          createdAt: project._creationTime,
          revision: project.revision,
          removal: project.removal,
        });
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [client, projectId, route.handle]);
  useEffect(read, [read]);
  const owner = !!viewerHandle && viewerHandle === route.handle;
  const trail = crumbsFor(route, projectName);
  if (!facts)
    return (
      <Head
        trail={trail}
        sentence={failed ? 'The project could not be read just now.' : 'Reading the project…'}
      />
    );
  return (
    <ProjectSettingsView
      facts={facts}
      owner={owner}
      trail={trail}
      lanes={feed ? { n: feed.lanes.length + feed.more, atLeast: feed.moreIsLowerBound } : null}
      now={Date.now()}
      rename={async ({ name, slug, operationId, expectedRevision }) => {
        await client.mutation(api.projectLifecycle.rename, {
          projectId,
          operationId,
          expectedRevision,
          name,
          slug,
        });
        if (slug !== facts.slug)
          navigate(hrefFor({ ...route, project: slug, place: 'settings', section: 'project', rest: '' }), {
            replace: true,
          });
        read();
      }}
      setVisibility={async change => {
        try {
          await client.mutation(api.projectVisibility.setVisibility, {
            projectId,
            visibility: change.visibility,
            operationId: change.operationId,
            expectedRevision: change.expectedRevision,
            ...(change.confirm === undefined ? {} : { confirm: change.confirm.trim() }),
          });
        } catch (failure) {
          read(); // a stale refusal shows the project as it is now; the next sheet opens at that revision
          throw failure;
        }
        read();
      }}
      extra={
        <>
          {owner ? <Backups projectId={projectId} owner /> : null}
          {owner ? <Imports /> : null}
        </>
      }
      moveToTrash={async () => {
        await run('trash', { id: projectId, revision: facts.revision });
        navigate(trashHref);
      }}
    />
  );
}
