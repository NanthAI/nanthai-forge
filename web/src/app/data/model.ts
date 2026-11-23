// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Your data as words (Item 17cdc774): what Forge holds for the account, kind by kind, what deleting each
// kind does, the metadata archive the person can take with them, the exact before-list a deletion removes and
// leaves, and where a deletion stands. Pure; the reads are convex/accountData.ts (overview, owned, shared, watch), the
// export is accountActions.inventory and the cleanup machine is accountActions.begin + advance.

export const KINDS = ['project', 'import', 'secret', 'agent', 'team', 'view', 'interest'] as const;
export type Kind = (typeof KINDS)[number];
/** Access the person has to other people's things; deleting their data also leaves these. */
export const LEAVES = ['projectReaders', 'projects', 'readers', 'secrets', 'teams', 'zones'] as const;
export type Leave = (typeof LEAVES)[number];
/** What the review lists row by row, in the order the server builds its token. Secret objects shared with the person
 * are not listed, counted or hashed: the deletion leaves the ones they had when they read the list. */
export const SHARED = ['projects', 'projectReaders', 'readers', 'teams', 'zones'] as const;
export type SharedKind = (typeof SHARED)[number];
/** One owned row as the overview and the review read it: a safe label, never a repository location. */
export type Row = { id: string; pin: string; label: string; note?: 'trash' | 'deleting' };
export type Owned = Row & { kind: Kind };
/** One row of what someone else shared with the person. Secret objects shared with them never come back as rows. */
export type Shared = { kind: SharedKind; id: string; label: string };
/** The export's rows (accountActions.inventory), with their full current metadata. */
export type Item = { kind: Kind; id: string; pin: string; metadata: Record<string, unknown> };
export type Receipt = { operationId: string; request: string; stage: string; at: number; kept?: number };
/** One kind as the overview read it: its first rows and whether there are more. */
export type Held = Record<Kind, { rows: readonly Row[]; more: boolean }>;
/** The exact before-list: everything owned, everything visibly shared, and the token binding both to the cleanup. */
export type Review = { owned: readonly Owned[]; shared: readonly Shared[]; incoming: string };
export type Request = {
  operationId: string;
  selection: { kind: Kind; id: string; pin: string }[];
  leave: Leave[];
  incoming: string;
};
/** Where a deletion stands. `failed`: Forge refused it (its words say why). `unknown`: Forge did not answer, so it may
 * or may not have started; asking again with the same operation finds out. `waiting`: removals still running
 * elsewhere; the page advances when one of them changes. */
export type Run = {
  operationId: string;
  stage: string;
  status: 'working' | 'waiting' | 'failed' | 'unknown' | 'done';
  /** Done: how many selected items Forge kept because they changed after the review. */
  kept?: number;
  words?: string;
  /** The refusal means the review is out of date: only a new review helps. */
  stale?: boolean;
};

export const KIND_WORDS: Record<Kind, { title: string; one: string; many: string; goes: string }> = {
  project: {
    title: 'Projects',
    one: 'project',
    many: 'projects',
    goes: 'deleted for good, with everything in them',
  },
  import: { title: 'Private imports', one: 'private import', many: 'private imports', goes: 'deleted' },
  secret: { title: 'Secret objects', one: 'secret object', many: 'secret objects', goes: 'deleted' },
  agent: { title: 'Agent access', one: 'agent access grant', many: 'agent access grants', goes: 'revoked' },
  team: { title: 'Teams you own', one: 'team', many: 'teams', goes: 'deleted' },
  view: { title: 'Saved views', one: 'saved view', many: 'saved views', goes: 'removed' },
  interest: {
    title: 'Watched and starred',
    one: 'watched repository',
    many: 'watched repositories',
    goes: 'removed',
  },
};
export const LEAVE_WORDS: Record<Leave, string> = {
  projects: 'Projects you contribute to',
  projectReaders: 'Projects shared with you to read',
  teams: 'Teams you are in',
  readers: 'Imports shared with you',
  zones: 'Source Zones you can read',
  secrets: 'Any secret objects shared with you',
};

/** "in the trash" / "being deleted" for a removed project; nothing for the rest. */
export function itemNote(row: Row) {
  if (row.note === 'trash') return 'in the trash';
  if (row.note === 'deleting') return 'being deleted';
  return null;
}

const count = (n: number, more: boolean, one: string, many: string) =>
  `${more ? 'at least ' : ''}${n.toLocaleString('en')} ${n === 1 && !more ? one : many}`;
export function kindCount(kind: Kind, held: Held[Kind]) {
  const n = held.rows.length;
  return n || held.more ? count(n, held.more, KIND_WORDS[kind].one, KIND_WORDS[kind].many) : 'None';
}

/** The page sentence: what Forge holds, the biggest thing first. */
export function sentence(held: Held) {
  const parts = KINDS.flatMap(kind => {
    const n = held[kind].rows.length;
    return n || held[kind].more
      ? [count(n, held[kind].more, KIND_WORDS[kind].one, KIND_WORDS[kind].many)]
      : [];
  });
  if (!parts.length) return 'Forge holds nothing of yours yet.';
  const listed = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
  return `Forge holds ${listed} for you.`;
}

/** The exact before-list a deletion selects: every owned row once, with the pin it was read at. */
export function selection(owned: readonly Owned[]) {
  return owned
    .map(({ kind, id, pin }) => ({ kind, id, pin }))
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}
/** The deletion request for a review: the person's owned rows and everything shared with them, bound by the token. */
export const request = (operationId: string, review: Review): Request => ({
  operationId,
  selection: selection(review.owned),
  leave: [...LEAVES],
  incoming: review.incoming,
});
/** What the delete key says: the exact number of things it removes, or that it only leaves what is shared. */
export function deleteWords(owned: readonly Owned[]) {
  const n = owned.length;
  if (!n) return 'Leave everything shared with you';
  return `Delete ${n.toLocaleString('en')} ${n === 1 ? 'item' : 'items'} for good`;
}
/** The typed confirmation: the account handle, exactly (case and spaces aside). */
export const confirmed = (typed: string, handle: string) =>
  typed.trim().toLowerCase() === handle.trim().toLowerCase() && handle.trim() !== '';

export function stageWords(stage: string) {
  if (stage === 'completed') return 'Done';
  if (stage === 'running') return 'Deleting';
  if (stage === 'ready') return 'Ready to continue';
  return 'Preparing';
}
/** An earlier deletion as the receipts list says it. One still preparing never deleted anything (nothing runs until
 * it is sealed); a new review starts again. */
export function receiptWords(stage: string, kept = 0) {
  if (stage === 'preparing') return 'Not started; nothing was deleted';
  if (stage === 'completed' && kept)
    return `Done; ${items(kept)} kept because ${kept === 1 ? 'it' : 'they'} changed`;
  return stageWords(stage);
}
const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/** Codes that say the review no longer matches what Forge holds or shares: only a fresh review can go on. */
const STALE = new Set(['ACCOUNT_CHANGED', 'ACCOUNT_OPERATION_CHANGED']);
/** A failed begin or advance, as the page shows it: refused (with Forge's words), or not answered at all. */
export function failure(
  run: Pick<Run, 'operationId' | 'stage'>,
  error: { code?: string; message?: string } | null,
): Run {
  if (!error?.code)
    return {
      ...run,
      status: 'unknown',
      words:
        'Forge did not answer, so this deletion may or may not have gone ahead. Check again to find out.',
    };
  return {
    ...run,
    status: 'failed',
    words: error.message || 'Forge refused this deletion.',
    stale: STALE.has(error.code),
  };
}

/** What the progress line says for a run. */
export function runWords(run: Run) {
  if (run.status === 'done')
    return run.kept
      ? `Done. Forge kept ${items(run.kept)} that changed after your review; everything else selected is deleted.`
      : 'Done: everything selected is deleted.';
  if (run.status === 'waiting')
    return 'Deleting. Some removals are still running; this page carries on when they finish.';
  if (run.status === 'failed' || run.status === 'unknown') return run.words ?? 'This deletion stopped.';
  return `${stageWords(run.stage)}…`;
}

/** The metadata archive (same format as before): ownership rows and operation receipts, never source or secrets. */
export function metadataArchive(items: readonly Item[], receipts: readonly Receipt[], observedAt: string) {
  return (
    JSON.stringify(
      {
        kind: 'forge-account-metadata',
        schemaVersion: 1,
        observedAt,
        coverage: KINDS,
        items,
        sourceAndCredentialBytes: 'separate current-authorized exports',
        receipts,
        grantsAuthority: 'historical-only',
      },
      null,
      2,
    ) + '\n'
  );
}
