// SPDX-License-Identifier: Apache-2.0
// The /approve lookup page (Item 0a99ab23) through its real component. The Convex client is a stand-in: the one read
// it makes, urlProjects:approvalTarget, answers per `?answer=` (`lane`, `needs` or `none`), and every read's name and
// arguments are kept on window.__reads.
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName } from 'convex/server';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import { ApproveRedirect } from '../../web/src/app/ApproveRedirect';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const answer = params.get('answer') ?? 'none';
const LANE = '7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
const target =
  answer === 'lane'
    ? { handle: 'sample-owner', slug: 'tide-pool', laneId: LANE }
    : answer === 'needs'
      ? { handle: 'sample-owner', slug: 'tide-pool', laneId: null }
      : null;
const reads: { name: string; args: unknown }[] = [];
(window as unknown as { __reads: typeof reads }).__reads = reads;
const client = {
  watchQuery: (ref: unknown, args: unknown) => {
    reads.push({ name: getFunctionName(ref as never), args });
    return {
      onUpdate: () => () => undefined,
      localQueryResult: () => target,
      journal: () => undefined,
    };
  },
} as unknown as ConvexReactClient;

createRoot(document.getElementById('root')!).render(
  <ConvexProvider client={client}>
    <ApproveRedirect search={params} />
  </ConvexProvider>,
);
