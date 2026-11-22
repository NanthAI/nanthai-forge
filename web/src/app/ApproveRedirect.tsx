// SPDX-License-Identifier: Apache-2.0
// An old /approve?project=…&submission=…|lane=… link (Item 0a99ab23), from agent output, mail or board text. One read
// (urlProjects:approvalTarget) names the project's address and the Lane whose page decides it; the address is then
// replaced, so the back button never returns here. A settings request, or a landing whose one Lane is not known, opens
// Needs me, which decides every kind. Nothing is decided on this page.
import { useEffect } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { PublicFrame, A } from './frames';
import { hrefFor } from './paths';
import { navigate } from './router';

export type ApproveTarget = { handle: string; slug: string; laneId: string | null };

/** The page an approval link opens: its Lane (naming the landing, so that exact attempt is decided), or Needs me. */
export function approveTargetHref(target: ApproveTarget, submission?: string) {
  const href = hrefFor({
    frame: 'project',
    handle: target.handle,
    project: target.slug,
    place: target.laneId ? 'lanes' : 'needs',
    section: '',
    rest: target.laneId ?? '',
  });
  return target.laneId && submission ? `${href}?submission=${encodeURIComponent(submission)}` : href;
}

/** What the link asks for, or null when it names no project or nothing in it. */
export function approveLinkArgs(search: URLSearchParams) {
  const projectId = search.get('project') ?? '',
    lane = search.get('lane') ?? '',
    submission = search.get('submission') ?? '';
  if (!projectId || (!lane && !submission)) return null;
  return { projectId, ...(lane ? { lane } : { submission }) };
}

export function ApproveRedirect({ search }: { search: URLSearchParams }) {
  const args = approveLinkArgs(search);
  const submission = args && 'submission' in args ? args.submission : undefined;
  const target = useQuery(api.urlProjects.approvalTarget, args ?? 'skip');
  useEffect(() => {
    if (target) navigate(approveTargetHref(target, submission), { replace: true });
  }, [target, submission]);
  if (args && target === undefined)
    return (
      <PublicFrame>
        <p className="quietline" aria-busy="true">
          Opening the approval…
        </p>
      </PublicFrame>
    );
  if (target) return null;
  return (
    <PublicFrame>
      <div className="intro">
        <h1>No approval to open</h1>
        <p>This link is incomplete, or it is for a project you cannot open with this account.</p>
        <p>
          <A href={hrefFor({ frame: 'account', place: 'projects' })}>Your projects</A>
        </p>
      </div>
    </PublicFrame>
  );
}
