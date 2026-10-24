// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { useUser } from '@clerk/react';
import { useConvex, useMutation, useQuery } from 'convex/react';
import { workIndex } from '../hosted-work-index';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import { cleanUrl, projectIdentity, projectRouteIdentity } from './location';
import { AppLoader } from '../ui/AppLoader';
import { ErrorToast } from '../ui/Toast';
import { hostedError } from '../snapshot';
/** Resolve before mounting URL consumers; they continue using internal IDs as state, never authority. */
export function ReadableRoute({ children }: { children: ReactNode }) {
  const [href, setHref] = useState(location.href);
  const [error, setError] = useState('');
  const { user } = useUser();
  const ensure = useMutation(api.urlAccounts.ensure);
  useEffect(() => {
    void ensure({
      ...(user?.username ? { username: user.username } : {}),
      ...(user?.firstName ? { firstName: user.firstName } : {}),
      ...(user?.lastName ? { lastName: user.lastName } : {}),
    }).catch(e => setError(hostedError(e)));
  }, [ensure, user?.username, user?.firstName, user?.lastName]);
  useEffect(() => {
    const changed = () => setHref(location.href);
    addEventListener('popstate', changed);
    return () => removeEventListener('popstate', changed);
  }, []);
  const path = projectRouteIdentity(href);
  const projectId = new URL(href).searchParams.get('project');
  const selected = !!path || !!projectId;
  const client = useConvex();
  useEffect(() => {
    if (!projectId) return;
    // ID routes already name these reads. Subscribe alongside canonical URL resolution;
    // the route gate still decides what renders, and each query checks current authority.
    const args = { projectId: projectId as Id<'hostedProjects'> };
    const stopWorkspace = client.watchQuery(workIndex.workspace, args).onUpdate(() => {});
    const stopProject = client.watchQuery(api.projectWork.state, args).onUpdate(() => {});
    return () => {
      stopWorkspace();
      stopProject();
    };
  }, [client, projectId]);
  const result = useQuery(
    api.urlProjects.resolve,
    selected ? { ...(path ?? {}), ...(projectId ? { projectId } : {}) } : 'skip',
  );
  if (result) projectIdentity(result.id, result.handle, result.name, result.slug, path ?? undefined);
  useEffect(() => {
    if (!result) return;
    history.replaceState(history.state, '', cleanUrl(href));
    dispatchEvent(new PopStateEvent('popstate'));
  }, [href, result]);
  if (selected && result === undefined) return <AppLoader />;
  if (selected && result === null)
    return (
      <main className="hosted-home">
        <h1>Project not found</h1>
      </main>
    );
  return (
    <>
      {error && <ErrorToast>{error}</ErrorToast>}
      {children}
    </>
  );
}
