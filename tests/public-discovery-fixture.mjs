// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getFunctionName } from 'convex/server';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const read = await import(moduleUrl('../convex/publicRead.ts'));

export const NOW = Date.UTC(2026, 10, 17, 12);
export const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

export function fixture({ projectVisibility = 'public', laneTitles, planVisibility, hidden = [] } = {}) {
  const s = state([]);
  s.tables.hostedProjects.set(
    'project',
    projectRow({
      _id: 'project',
      _creationTime: NOW - 30 * 86_400_000,
      owner: 'owner',
      name: 'atlas',
      slug: 'atlas',
      visibility: projectVisibility,
      work: { generationId: 'gen', backupId: 'backup', operationId: 'op', initialRevision: 0, revision: 0 },
    }),
  );
  // The planning contract's project setting (d3357f40); set past the schema until that field is on main.
  if (planVisibility) s.tables.hostedProjects.get('project').planVisibility = planVisibility;
  s.tables.forgeAccounts.set('acct', { _id: 'acct', owner: 'owner', handle: 'ada' });
  s.tables.accountHandles.set('alias', { _id: 'alias', owner: 'owner', handle: 'ada' });
  s.tables.projectSlugs.set('slug', { _id: 'slug', owner: 'owner', slug: 'atlas', projectId: 'project' });
  s.tables.projectWorkGenerations.set('gen', {
    _id: 'gen',
    projectId: 'project',
    backupId: 'backup',
    format: 11,
    status: 'ready',
    initialRevision: 0,
    revision: 0,
    metadata: '{"schema":24}',
  });
  s.tables.projectPublic.set('public', {
    _id: 'public',
    _creationTime: NOW - 86_400_000,
    projectId: 'project',
    owner: 'owner',
    listed: projectVisibility === 'public',
    stars: 0,
    ...(laneTitles ? { laneTitles } : {}),
  });
  // Plan: an Initiative with two Items, a loose Item, and an Item someone may hide.
  const plan = [
    { id: id(1), kind: 'initiative', status: 'open', title: 'Secret initiative' },
    { id: id(2), kind: 'issue', status: 'open', title: 'Under the initiative', initiativeId: id(1) },
    { id: id(3), kind: 'issue', status: 'in-progress', title: 'Also under it', initiativeId: id(1) },
    { id: id(4), kind: 'issue', status: 'open', title: 'Loose planned item' },
    { id: id(5), kind: 'issue', status: 'proposed', title: 'Private-looking item' },
  ];
  plan.forEach((item, position) =>
    s.tables.projectPlanningRecords.set(`plan${position}`, {
      _id: `plan${position}`,
      projectId: 'project',
      generationId: 'gen',
      collection: 'planningSearch',
      key: item.id,
      parent: '',
      position,
      value: JSON.stringify({
        ...item,
        initiativeId: item.initiativeId ?? null,
        ...(hidden.includes(item.id) ? { hidden: true } : {}),
      }),
      planning: {
        text: item.title,
        kind: item.kind,
        status: item.status,
        initiativeId: item.initiativeId ?? '',
        open: true,
      },
    }),
  );
  for (const [n, stage] of [
    [1, 'editing'],
    [2, 'checking'],
  ])
    s.tables.projectLiveLineLanes.set(`mark${n}`, {
      _id: `mark${n}`,
      projectId: 'project',
      sourceId: `source${n}`,
      laneId: `lane-${n}`,
      stage,
      held: n === 2,
      overlap: false,
      changedAt: NOW,
    });
  // Each Lane's hosted head names its Intent: here the visible loose Item's.
  for (const n of [1, 2])
    s.tables.projectHostedRecordHeads.set(`laneHead${n}`, {
      _id: `laneHead${n}`,
      projectId: 'project',
      kind: 'lane',
      key: `lane-${n}`,
      parent: id(4),
      status: 'active',
    });
  s.tables.projectWorkRecords.set('laneRecord1', {
    _id: 'laneRecord1',
    projectId: 'project',
    generationId: 'gen',
    collection: 'lanes',
    key: 'lane-1',
    parent: '',
    position: 0,
    value: JSON.stringify({ id: 'lane-1', name: 'Secret Lane title', intentId: id(4) }),
  });
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, fn] = getFunctionName(ref).split(':');
    return { publicRead: read }[module][fn]._handler(s.ctx, args);
  };
  return s;
}
