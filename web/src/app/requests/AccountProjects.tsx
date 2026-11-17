// SPDX-License-Identifier: Apache-2.0
// The account's projects place (requests/route.ts). With ?request=ID it is the bulk delete request page (Item
// 7456856f), loaded with its own chunk; without one it keeps the place's placeholder.
import { lazy, Suspense } from 'react';
import { Head, Placeholder } from '../Place';
import { useSearch } from '../router';
import type { AccountProps } from '../screen-route';

const DeleteRequest = lazy(() => import('./DeleteRequest'));

export default function AccountProjects(_: AccountProps) {
  const request = useSearch().get('request');
  if (!request) return <Placeholder route={{ frame: 'account', place: 'projects' }} projectName="" />;
  return (
    <Suspense fallback={<Head trail={[{ label: 'Delete request' }]} sentence="Loading the request…" />}>
      <DeleteRequest requestId={request} />
    </Suspense>
  );
}
