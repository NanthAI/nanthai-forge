// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs me on synthetic data (Items 3fa3187d, 0cb9b064), through its real view: exact progress counts with today's
// closures beside Done (or, with ?capped, a capped read whose every figure reads "N+"), one Lane waiting for
// approval in Needs you and one landing its agent withdrew, listed under FYI (Item 48049998).
import { createRoot } from 'react-dom/client';
import '../../web/src/app/app.css';
import type { LineFeed } from '../../web/src/app/Line';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const capped = params.has('capped');

const NOW = Date.now();
const lane = (laneId: string, held: boolean) => ({
  laneId,
  stage: 'ready' as const,
  held,
  overlap: false,
  changedAt: NOW - 40 * 60_000,
});
const feed: LineFeed = {
  lanes: [
    lane('9e8e8826-db5d-40d1-9199-328383d25641', true),
    lane('4333f92b-12c5-4ac3-b811-b4ff78d48840', false),
    lane('e698324f-a04c-4eb1-9d82-2ef3582ad943', false),
  ],
  more: 0,
  moreIsLowerBound: false,
  main: null,
};
const held = (laneId: string, title: string, why: 'review' | 'withdrawn', note: string | null) => ({
  laneId,
  intentId: null,
  title,
  actor: 'mara',
  agent: 'quiet-otter',
  why,
  note,
  submissionId: null,
  since: NOW - 40 * 60_000,
});
const read = {
  held: [
    held(
      '9e8e8826-db5d-40d1-9199-328383d25641',
      'Public pages: share cards, sitemap and page titles',
      'review',
      null,
    ),
    held(
      '4333f92b-12c5-4ac3-b811-b4ff78d48840',
      'Site function for share cards',
      'withdrawn',
      'Withdrawn to add a delta.',
    ),
  ],
  more: 0,
  moreIsLowerBound: false,
  approvals: JSON.stringify({ requests: [], complete: true }),
  canDecide: true,
};
const issue = { proposed: 8, open: 237, inProgress: 57, closed: 579, abandoned: 40 };
const counts = capped
  ? {
      exact: false,
      issue: { proposed: 3, open: 49, inProgress: 7, closed: 200, abandoned: 0 },
      closedToday: null,
    }
  : { exact: true, issue, closedToday: { day: new Date(NOW).toISOString().slice(0, 10), n: 12 } };

// Loaded lazily, as the app does, so the behaviour layer stays out of first paint (web/vite.config.ts).
const { NeedsMeView } = await import('../../web/src/app/needs/NeedsMe');
createRoot(document.getElementById('root')!).render(
  <NeedsMeView
    route={{ frame: 'project', handle: 'mara', project: 'forge', place: 'needs', section: '', rest: '' }}
    projectName="forge"
    feed={feed}
    read={read}
    counts={counts}
    fyi={{
      owner: true,
      state: { clearedAt: null, clearedSequence: null, dismissed: [] },
      landings: [],
      landingsMore: false,
      broke: [],
      settings: [],
      access: [],
      messages: [],
      messagesMore: false,
    }}
    decide={async () => ''}
    answer={async () => {}}
    dismiss={async () => ''}
  />,
);
