// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The account's projects place (requests/route.ts). With ?request=ID it is the bulk delete request page (Item
// 7456856f); without one it is the projects list (projects/Projects.tsx, Item 3d5d8839). Each loads its own chunk.
import { lazy, Suspense } from 'react';
import { Head } from '../Place';
import { useSearch } from '../router';
import type { AccountProps } from '../screen-route';

const DeleteRequest = lazy(() => import('./DeleteRequest'));
const Projects = lazy(() => import('../projects/Projects'));
const Trash = lazy(() => import('../trash/Trash'));

export default function AccountProjects(props: AccountProps) {
  const search = useSearch();
  const request = search.get('request');
  if (!request && search.get('view') === 'trash')
    return (
      <Suspense fallback={<Head trail={[{ label: 'Trash' }]} sentence="The trash." />}>
        <Trash />
      </Suspense>
    );
  if (!request)
    return (
      <Suspense fallback={<Head trail={[{ label: 'Projects' }]} sentence="Loading…" />}>
        <Projects {...props} />
      </Suspense>
    );
  return (
    <Suspense fallback={<Head trail={[{ label: 'Delete request' }]} sentence="Loading the request…" />}>
      <DeleteRequest requestId={request} />
    </Suspense>
  );
}
