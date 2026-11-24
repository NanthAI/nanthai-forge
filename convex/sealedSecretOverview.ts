// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// sealedSecrets:overview (Item 41a0df87, slice 4): the Secrets page's one names-only read. It reads the project's
// active set rows by index (at most three), the project's contributors in one bounded page to match roster accounts to
// public handles, and one account row per matched holder. It does not read the history row, a proposal row or a
// credential row, and it returns no value, ciphertext or key (sealedSecretOverviewFields has no bytes field).
import type { Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { overviewResult } from './sealedSecretOverviewFields';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { hasWriteRole } from './projectRole';
import { planningMembers } from './personWork';
import { invariant } from '../src/errors';
import { decodeSealedWire } from '../src/sealed-wire';
import { equalBytes, forgeSecretId, hex } from '../src/sealed-portable';
import { deviceFingerprint } from '../src/sealed-join';
import type { Head, Roster } from '../src/sealed-records';
import {
  holderRows,
  nameRows,
  OVERVIEW_PAGE,
  rotateRows,
  takeOutRows,
  type OverviewSet,
} from '../src/sealed-overview';

type Kind = 1 | 2 | 3;
type Part = 'names' | 'people' | 'rotate';
const u8 = (b: ArrayBuffer) => new Uint8Array(b);

function slice<T>(
  rows: readonly T[],
  after: string | undefined,
  size: number,
  key: (row: T, index: number) => string,
) {
  const from = after === undefined ? 0 : rows.findIndex((row, i) => key(row, i) > after!);
  const start = from < 0 ? rows.length : from;
  const page = rows.slice(start, start + size);
  const last = page.length ? key(page[page.length - 1]!, start + page.length - 1) : null;
  return { total: rows.length, page, next: start + size < rows.length ? last : null };
}

export async function overviewFor(
  ctx: QueryCtx,
  args: { projectId: Id<'hostedProjects'>; kind?: Kind; part?: Part; after?: string },
): Promise<Infer<typeof overviewResult>> {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'AUTH_REQUIRED', 'Sign in to read secret names.');
  const project = await accessibleProject(ctx, args.projectId, user.subject);
  if (!(await hasWriteRole(ctx, project, user.subject))) return { status: 'reader' as const };
  invariant(
    (args.part === undefined) === (args.kind === undefined),
    'BAD_ARGUMENT',
    'A page of one set names its part and kind.',
  );
  const rows = [];
  for (const kind of args.kind ? [args.kind] : ([1, 2, 3] as const)) {
    const set = await ctx.db
      .query('sealedSecretSets')
      .withIndex('by_project_and_kind_and_active', q =>
        q.eq('projectId', args.projectId).eq('kind', kind).eq('active', true),
      )
      .unique();
    if (set) rows.push(set);
  }
  const decoded = rows.map(set => {
    const { head, roster } = decodeSealedWire(u8(set.payload)) as { head: Head; roster: Roster };
    const view: OverviewSet = {
      head,
      roster,
      revoked: (set.revoked ?? []).map(u8),
      notes: (set.revokedNotes ?? []).map(n => ({
        id: u8(n.id),
        at: n.at,
        ...(n.handle ? { handle: n.handle } : {}),
      })),
      formerHandles: (set.formerHandles ?? []).map(h => ({ id: u8(h.id), handle: h.handle })),
      joinRequests: (set.joinRequests ?? []).map(j => ({
        deviceId: u8(j.deviceId),
        accountId: (decodeSealedWire(u8(j.request)) as { accountId?: Uint8Array }).accountId ?? null,
        at: j.at,
      })),
      proposals: (set.proposals ?? []).map(p => ({
        proposalId: u8(p.proposalId),
        proposerId: u8(p.proposerId),
        name: p.name,
        at: p.at,
        ...(p.op ? { op: p.op } : {}),
        ...(p.kind ? { kind: p.kind } : {}),
      })),
    };
    return { set, view };
  });
  // Roster accounts that are the owner or a listed contributor get their public handle (one account row each).
  const wanted = new Set(
    decoded.flatMap(d => d.view.roster.entries.filter(e => e.accountId.length).map(e => hex(e.accountId))),
  );
  const handles = new Map<string, string>();
  if (wanted.size) {
    // The owner, the direct writers and the writers of linked teams, in one bounded listing (personWork.ts).
    for (const account of await planningMembers(ctx, project)) {
      const id = hex(forgeSecretId('account', account));
      if (!wanted.has(id)) continue;
      const row = await ctx.db
        .query('forgeAccounts')
        .withIndex('by_owner', q => q.eq('owner', account))
        .unique();
      if (row?.handle) handles.set(id, row.handle);
    }
  }
  const handleOf = (accountId: Uint8Array) => handles.get(hex(accountId)) ?? null;
  const self = forgeSecretId('account', user.subject);
  const sets = decoded.map(({ set, view }) => {
    const all = !args.part;
    const proposerHandle = (id: Uint8Array) =>
      handleOf(view.roster.entries.find(e => equalBytes(e.id, id))?.accountId ?? new Uint8Array());
    const formerHandle = (id: Uint8Array) =>
      view.formerHandles.find(h => equalBytes(h.id, id))?.handle ?? null;
    const base = {
      kind: set.kind,
      sharing: view.roster.sharingMode === 1 ? ('automatic' as const) : ('confirm' as const),
      headVersion: set.headVersion,
    };
    if (all) {
      const holders = holderRows(view, self, handleOf);
      const people = slice(holders.people, undefined, OVERVIEW_PAGE.people, (_r, i) =>
        String(i).padStart(6, '0'),
      );
      return {
        ...base,
        takeOut: takeOutRows(view, handleOf),
        proposals: [...view.proposals]
          .sort((a, b) => b.at - a.at)
          .map(p => ({
            id: hex(p.proposalId),
            op: p.op ?? null,
            name: p.name,
            kind: p.kind ?? null,
            from: deviceFingerprint(p.proposerId),
            handle: proposerHandle(p.proposerId),
            at: p.at,
          })),
        rotate: rotatePage(view, undefined, formerHandle),
        names: slice(nameRows(view, handleOf), undefined, OVERVIEW_PAGE.names, r => r.name),
        people,
        machines: holders.machines,
        waiting: view.joinRequests.map(j => ({
          code: deviceFingerprint(j.deviceId),
          handle: j.accountId ? handleOf(j.accountId) : null,
          at: j.at,
        })),
      };
    }
    if (args.part === 'names')
      return {
        ...base,
        names: slice(nameRows(view, handleOf), args.after, OVERVIEW_PAGE.names, r => r.name),
      };
    if (args.part === 'rotate') return { ...base, rotate: rotatePage(view, args.after, formerHandle) };
    return {
      ...base,
      people: slice(holderRows(view, self, handleOf).people, args.after, OVERVIEW_PAGE.people, (_r, i) =>
        String(i).padStart(6, '0'),
      ),
    };
  });
  return {
    status: 'ok' as const,
    now: Date.now(),
    needs: project.secretsNeeds ?? 0,
    sets,
  };
}

function rotatePage(
  view: OverviewSet,
  after: string | undefined,
  formerHandle: (id: Uint8Array) => string | null,
) {
  const rows = rotateRows(view.roster, view.head).map(({ record, former, machines }) => ({
    name: record.name,
    kind: record.kind,
    version: record.valueVersion,
    devices: former
      .slice(0, 3)
      .map(f => ({ code: deviceFingerprint(f.deviceId), handle: formerHandle(f.deviceId) })),
    more: Math.max(0, former.length - 3),
    // A removed CI machine that could open it: its short id only (it has no sign-in, so no handle).
    ...(machines.length ? { machines: machines.slice(0, 3).map(f => hex(f.deviceId).slice(0, 8)) } : {}),
  }));
  return slice(rows, after, OVERVIEW_PAGE.rotate, r => r.name);
}
