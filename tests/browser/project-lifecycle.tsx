// SPDX-License-Identifier: Apache-2.0
// Synthetic transport for actual production controls; no provider identity/storage claims.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference, type FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import ProjectLifecycle from '../../web/src/ProjectLifecycle';
import { Wordmark, ThemeControl } from '../../web/src/Brand';
import '../../web/src/style.css';
import '../../web/src/hosted.css';
import '../../web/src/work.css';
type Project = FunctionReturnType<typeof api.projectBackups.list>['page'][number];
const initial: Project = {
  id: 'synthetic-project' as Id<'hostedProjects'>,
  key: '11111111-1111-4111-8111-111111111111',
  name: 'Forge lifecycle · a synthetic project with a longer name',
  currentBackup: 'synthetic-backup' as Id<'projectBackups'>,
  revision: 1,
};
function Fixture() {
  const [project, setProject] = useState(initial),
    [loseReply, setLoseReply] = useState(false);
  const [client] = useState(() => {
    let current = { ...initial },
      failNext = false;
    const operations = new Set<string>();
    const value = {
      mutation: async (
        fn: FunctionReference<'mutation'>,
        input: { operationId: string; expectedRevision: number },
      ) => {
        const name = getFunctionName(fn);
        if (name === 'projectLifecycle:reconcile') return { cursor: '', isDone: true };
        if (!operations.has(input.operationId)) {
          if (input.expectedRevision !== current.revision) throw Error('Synthetic stale project revision');
          operations.add(input.operationId);
          current = {
            ...current,
            revision: current.revision + 1,
            removal: name.endsWith(':trash') ? 'trash' : name.endsWith(':restore') ? undefined : 'deleted',
          };
          if (current.removal === 'deleted') {
            current.name = '';
            current.currentBackup = null;
          }
          setProject({ ...current });
        }
        if (failNext) {
          failNext = false;
          setLoseReply(false);
          throw Error('Synthetic lost reply after successful write');
        }
        return null;
      },
      fail: () => {
        failNext = true;
      },
    };
    return value as unknown as ConvexReactClient & { fail: () => void };
  });
  return (
    <div className="app">
      <header className="header hosted-header">
        <Wordmark />
        <ThemeControl />
      </header>
      <main className="hosted-home">
        <h1>{project.name || 'Removed project'}</h1>
        <p>Production project controls with synthetic storage and identity. No real project is modified.</p>
        <button
          disabled={loseReply}
          onClick={() => {
            client.fail();
            setLoseReply(true);
          }}
        >
          Lose next operation reply
        </button>
        <p role="status">
          Project state: {project.removal ?? 'active'} · revision {project.revision}
        </p>
        <ConvexProvider client={client}>
          <ProjectLifecycle project={project} />
        </ConvexProvider>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
