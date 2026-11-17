// SPDX-License-Identifier: Apache-2.0
// The workflow files on main, with what each runs on (Item 0c9207b8). Asked only while the owner is choosing a check:
// one folder read of .github/workflows at main's head, then the first page of at most WORKFLOWS_READ files, through
// the Code place's bounded source read (projectCodeBrowse.read: same access check, no signed URL, 16,000-character
// pages). Every answer is for an exact State and kept for the visit (code-data.ts), so reopening asks nothing.
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { browse, messageOf, type CodeDir, type CodeFile } from '../code/code-data';
import {
  WORKFLOW_DIR,
  WORKFLOWS_READ,
  workflowPaths,
  workflowTrigger,
  type FoundWorkflow,
} from './workflows';

export type Workflows =
  | { kind: 'idle' | 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'found'; found: FoundWorkflow[] };

export function useWorkflows(projectId: Id<'hostedProjects'>, state: string | null | undefined, on: boolean) {
  const client = useConvex();
  const [result, setResult] = useState<Workflows>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!on || !state) return;
    let live = true;
    setResult({ kind: 'loading' });
    const ask = <T>(args: Record<string, unknown>) => browse<T>(client, { projectId, state, ...args });
    void ask<{ dirs?: CodeDir[]; available?: false; reason?: string }>({
      want: 'more',
      path: WORKFLOW_DIR,
      cursor: 0,
    })
      .then(async reply => {
        if (reply.available === false) throw new Error(reply.reason ?? 'This source is not available.');
        const paths = workflowPaths(
          (reply.dirs?.[0]?.entries ?? []).filter(entry => entry.kind === 'file').map(entry => entry.path),
        );
        const found = await Promise.all(
          paths.map(async (path, index): Promise<FoundWorkflow> => {
            if (index >= WORKFLOWS_READ) return { path, trigger: null };
            const { file } = await ask<{ file: CodeFile }>({ want: 'page', path });
            const page = file.available ? file.page : null;
            return {
              path,
              trigger: page?.kind === 'text' ? workflowTrigger(page.text) : { kind: 'unknown' },
            };
          }),
        );
        if (live) setResult({ kind: 'found', found });
      })
      .catch(
        error =>
          live &&
          setResult({
            kind: 'failed',
            message: error instanceof Error && !('data' in error) ? error.message : messageOf(error),
          }),
      );
    return () => {
      live = false;
    };
  }, [client, projectId, state, on, attempt]);
  return {
    result: on && state ? result : ({ kind: 'idle' } as Workflows),
    retry: () => setAttempt(n => n + 1),
  };
}
