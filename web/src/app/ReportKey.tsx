// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A quiet Report key (Item b6588425 line 2). The sheet and its input schema load only when it opens, so public pages
// that show the key carry no report code until someone reports.
import { lazy, Suspense, useState } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import { Key } from '../ds';
import type { ReportTarget } from './ReportAbuse';

const ReportSheet = lazy(() => import('./ReportAbuse').then(module => ({ default: module.ReportSheet })));

export function ReportKey({
  projectId,
  target,
  label = 'Report',
}: {
  projectId?: Id<'hostedProjects'> | undefined;
  target: ReportTarget;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Key size="sm" kind="ghost" onClick={() => setOpen(true)}>
        {label}
      </Key>
      {open ? (
        <Suspense fallback={null}>
          <ReportSheet projectId={projectId} target={target} close={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
