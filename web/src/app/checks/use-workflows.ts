// SPDX-License-Identifier: Apache-2.0
// The CI files on main (Item 0c9207b8), through the Code place's bounded source read (projectCodeBrowse.read: same
// access check, no signed URL, 200-entry folder pages, 16,000-character file pages). Every answer is for an exact
// State and kept for the visit (code-data.ts), so reopening asks nothing.
// - While the owner chooses a check: one page of main's root folder (which CI's files it holds), then, only when the
//   root has .github, one folder read of .github/workflows and the first page of at most WORKFLOWS_READ files.
// - With a CI file chosen and no landing checked yet: the first page of that one file.
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { browse, messageOf, type CodeDir, type CodeFile } from '../code/code-data';
import { ciFiles, type CiFiles } from './ci';
import {
  WORKFLOW_DIR,
  WORKFLOWS_READ,
  workflowPaths,
  workflowTrigger,
  type FoundWorkflow,
  type Trigger,
} from './workflows';

type Listing = { dirs?: CodeDir[]; available?: false; reason?: string };
export type Workflows =
  | { kind: 'idle' | 'loading' }
  | { kind: 'failed'; message: string }
  /** `complete`: the root listing fitted one page, so a CI file not seen is not there. */
  | { kind: 'found'; found: FoundWorkflow[]; files: CiFiles; complete: boolean };

const words = (error: unknown) =>
  error instanceof Error && !('data' in error) ? error.message : messageOf(error);
/** null: the State has no such file. undefined: the source could not be read, so nothing is known. */
const triggerOf = (file: CodeFile): Trigger | null | undefined =>
  !file.available
    ? undefined
    : !file.blob
      ? null
      : file.page?.kind === 'text'
        ? workflowTrigger(file.page.text)
        : { kind: 'unknown' };

export function useWorkflows(projectId: Id<'hostedProjects'>, state: string | null | undefined, on: boolean) {
  const client = useConvex();
  const [result, setResult] = useState<Workflows>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!on || !state) return;
    let live = true;
    setResult({ kind: 'loading' });
    const ask = <T>(args: Record<string, unknown>) => browse<T>(client, { projectId, state, ...args });
    const folder = async (path: string) => {
      const reply = await ask<Listing>({ want: 'more', path, cursor: 0 });
      if (reply.available === false) throw new Error(reply.reason ?? 'This source is not available.');
      return reply.dirs?.[0] ?? { path, entries: [], total: 0, next: null };
    };
    void folder('')
      .then(async root => {
        const files = ciFiles(root.entries);
        const paths = files.github
          ? workflowPaths(
              (await folder(WORKFLOW_DIR)).entries
                .filter(entry => entry.kind === 'file')
                .map(entry => entry.path),
            )
          : [];
        const found = await Promise.all(
          paths.map(async (path, index): Promise<FoundWorkflow> => {
            if (index >= WORKFLOWS_READ) return { path, trigger: null };
            const { file } = await ask<{ file: CodeFile }>({ want: 'page', path });
            return { path, trigger: triggerOf(file) ?? { kind: 'unknown' } };
          }),
        );
        if (live) setResult({ kind: 'found', found, files, complete: root.next === null });
      })
      .catch(error => live && setResult({ kind: 'failed', message: words(error) }));
    return () => {
      live = false;
    };
  }, [client, projectId, state, on, attempt]);
  return {
    result: on && state ? result : ({ kind: 'idle' } as Workflows),
    retry: () => setAttempt(n => n + 1),
  };
}

/** What one CI file on main runs on: null when the file is not there, undefined while unread or unreadable. */
export function useWorkflowTrigger(
  projectId: Id<'hostedProjects'>,
  state: string | null | undefined,
  path: string | null,
) {
  const client = useConvex();
  const [answer, setAnswer] = useState<{ key: string; trigger: Trigger | null | undefined } | null>(null);
  const key = state && path ? `${state}:${path}` : null;
  useEffect(() => {
    if (!key) return;
    let live = true;
    void browse<{ file: CodeFile }>(client, { projectId, state, want: 'page', path })
      .then(reply => live && setAnswer({ key, trigger: triggerOf(reply.file) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, projectId, state, path, key]);
  return answer && answer.key === key ? answer.trigger : undefined;
}
