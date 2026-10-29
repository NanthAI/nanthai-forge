// SPDX-License-Identifier: Apache-2.0
'use node';
import { ownerDerivedSchema, OWNER_DERIVED_MAX_BYTES } from '../src/owner-derived';
import { digest } from '../src/hash';
import { stateParentEntries } from '../src/source-state-parent-index';
import { sourceTreeEntries } from '../src/source-tree-index';
import { invariant, ForgeError } from '../src/errors';
import { resolveOwnerDerived } from '../src/owner-derived-pages';
import { safeRelative } from '../src/files';
import type { WorkData } from '../src/work-types';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import type { z } from 'zod';

export type OwnerProjectionContext = {
  snapshot: { data: WorkData; manifest: z.infer<typeof sourceManifestSchema> };
  pending: string[];
  parents: [string, string[]][];
  heads: string[];
  diffstats?: { records: IndexEntry[] };
  delta?: { stopParents: string[]; views: number[]; trees?: string[] };
};
import type { IndexEntry } from '../src/work-hosted-index';

/** Validate owner display facts without reading source or recomputing provenance. */
export function ownerDerivedRows(
  c: OwnerProjectionContext,
  value: unknown,
): { rows: IndexEntry[] } | { reason: string } {
  try {
    if (!c.delta) return { reason: 'delta-missing' };
    const parsed = ownerDerivedSchema.safeParse(value);
    if (!parsed.success) return { reason: 'schema-invalid' };
    const d = parsed.data,
      pins = new Set(
        c.snapshot.manifest.files.filter(p => p.path === `objects/${p.sha256}`).map(p => p.sha256),
      );
    if (d.work !== c.snapshot.manifest.files.find(file => file.path === 'work.json')?.sha256)
      return { reason: 'work-pin-mismatch' };
    if (!unique(d.parents) || !unique(d.ancestry) || !unique(d.stats) || !unique(d.views) || !unique(d.trees))
      return { reason: 'duplicate-key' };
    for (const [head, parents] of [...d.parents, ...d.ancestry])
      if (!pins.has(head) || parents.some(p => !pins.has(p))) return { reason: 'parent-pin-missing' };
    for (const [key] of d.stats)
      if (key.split(':').length !== 2 || key.split(':').some(p => !pins.has(p)))
        return { reason: 'stats-pin-missing' };
    const parents = new Map(d.parents),
      closures = new Map(d.ancestry),
      stats = new Map(d.stats),
      trees = new Map(d.trees),
      views = new Map(d.views.map(([id, fingerprint, rows]) => [id, { fingerprint, rows }]));
    const rows: IndexEntry[] = [],
      pending = [...c.pending],
      seen = new Set([...c.delta.stopParents, ...c.parents.map(([head]) => head)]);
    while (pending.length) {
      const head = pending.pop()!;
      if (seen.has(head)) continue;
      seen.add(head);
      const list = parents.get(head);
      if (!list) return { reason: `pending-parent-missing:${head}` };
      rows.push(...stateParentEntries(head, list));
      pending.push(...list);
    }
    // Every new State supplies only itself and references to its parents. Readers
    // compose these boundaries with existing closures/parent caches on demand.
    for (const [head, list] of d.ancestry) {
      if (JSON.stringify(parents.get(head)) !== JSON.stringify(list))
        return { reason: `ancestry-parents-differ:${head}` };
      const chunks = Math.ceil((list.length + 1) / 1000);
      rows.push({
        collection: 'sourceAncestryClosure',
        key: head,
        parent: '',
        position: 0,
        value: JSON.stringify({ head, chunks, complete: list.length === 0 }),
      });
      const ancestors = [head, ...list];
      for (let i = 0; i < chunks; i++) {
        const part = ancestors.slice(i * 1000, (i + 1) * 1000);
        rows.push({
          collection: 'sourceAncestryChunk',
          key: `${head}:${i}`,
          parent: head,
          position: i,
          value: JSON.stringify({ ancestors: part, boundaries: part.filter(p => p !== head) }),
        });
      }
    }
    for (const head of c.heads)
      if (!closures.has(head) && !c.delta.stopParents.includes(head))
        return { reason: `head-ancestry-missing:${head}` };
    for (const record of c.diffstats?.records ?? []) {
      const value = JSON.parse(record.value),
        key = `${value.base}:${value.head}`;
      if (!value.head || value.status === 'conflict') {
        rows.push(record);
        continue;
      }
      const supplied = stats.get(key);
      if (!supplied || (supplied.add === undefined) !== (supplied.del === undefined))
        return { reason: `stats-missing-or-unpaired:${key}` };
      const changes = { ...supplied, provenance: 'owner-reported', exact: supplied.add !== undefined };
      rows.push({ ...record, value: JSON.stringify({ ...value, changes }) });
      if (!rows.some(r => r.collection === 'diffstats' && r.key === key))
        rows.push({ collection: 'diffstats', key, parent: '', position: 0, value: JSON.stringify(changes) });
    }
    for (const index of c.delta.views) {
      const view = c.snapshot.data.views[index]!,
        supplied = views.get(view.id);
      if (!supplied || !/^[a-f0-9]{64}$/.test(supplied.fingerprint))
        return { reason: `view-missing:${view.id}` };
      const ids = new Set<string>();
      for (const row of supplied.rows) {
        const identity = JSON.stringify([row.collection, row.key]);
        if (ids.has(identity)) return { reason: 'view-row-duplicate' };
        ids.add(identity);
        if (
          ![
            'viewDetails',
            'viewFiles',
            'laneViews',
            'viewAcceptances',
            'viewDetails:payload',
            'viewFiles:payload',
            'laneViews:payload',
            'viewAcceptances:payload',
          ].includes(row.collection)
        )
          return { reason: 'view-collection-invalid' };
        if (row.collection.startsWith('viewFiles') && !row.key.startsWith(`${view.id}:`))
          return { reason: 'view-file-key-invalid' };
        if (Buffer.byteLength(row.value) > 500000) return { reason: 'view-row-too-large' };
        if (row.collection === 'viewDetails' && (row.key !== view.id || row.parent !== view.intentId))
          return { reason: 'view-detail-key-invalid' };
        if (row.collection === 'viewAcceptances' && row.parent !== view.id)
          return { reason: 'view-acceptance-parent-invalid' };
        if (
          row.collection === 'laneViews' &&
          !view.inputs.some(input => row.key === `${input.laneId}:${view.id}` && row.parent === input.laneId)
        )
          return { reason: 'view-lane-invalid' };
        if (row.collection.endsWith(':payload')) {
          if (
            !supplied.rows.some(
              header =>
                header.collection === row.collection.slice(0, -8) &&
                JSON.parse(header.value).payloadKey === row.parent,
            )
          )
            return { reason: 'view-payload-header-missing' };
        } else if (!validPins(unpack(row, supplied.rows), pins)) return { reason: 'view-pin-missing' };
      }
      const detail = supplied.rows.find(r => r.collection === 'viewDetails' && r.key === view.id);
      if (!detail) return { reason: 'view-detail-missing' };
      const summary = unpack(detail, supplied.rows);
      const fileRows = supplied.rows.filter(r => r.collection === 'viewFiles');
      if (
        summary.viewId !== view.id ||
        summary.intentId !== view.intentId ||
        summary.base !== view.base ||
        summary.head !== (view.head ?? null) ||
        !Array.isArray(summary.inputs) ||
        !['accepted', 'superseded', 'ready', 'conflict'].includes(summary.status) ||
        typeof summary.provenanceAvailable !== 'boolean' ||
        (summary.fileCount !== null &&
          (!Number.isSafeInteger(summary.fileCount) ||
            summary.fileCount < 0 ||
            summary.fileCount !== fileRows.length))
      )
        return { reason: 'view-summary-invalid' };
      if (
        view.status === 'conflict'
          ? summary.fileCount !== null || summary.provenanceAvailable
          : !summary.provenanceAvailable
      )
        return { reason: 'view-provenance-invalid' };
      for (const fileRow of fileRows) {
        const file = unpack(fileRow, supplied.rows);
        if (
          fileRow.parent !== view.id ||
          fileRow.key !== `${view.id}:${file.path}` ||
          !['added', 'deleted', 'modified'].includes(file.status) ||
          typeof file.path !== 'string' ||
          !safeRelative(file.path) ||
          typeof file.historyComplete !== 'boolean' ||
          !Array.isArray(file.contributors)
        )
          return { reason: 'view-file-invalid' };
        for (const version of [file.before, file.after])
          if (
            version !== null &&
            (!version ||
              typeof version.path !== 'string' ||
              !pins.has(version.blob) ||
              !['file', 'executable', 'symlink'].includes(version.mode))
          )
            return { reason: 'view-version-invalid' };
      }
      rows.push(...supplied.rows);
    }
    const main = c.snapshot.manifest.head;
    for (const head of new Set([
      main,
      ...(c.snapshot.data.hostedChannelMoves ?? [])
        .filter(m => m.channel === 'main')
        .slice(-1)
        .map(m => m.head),
      ...c.snapshot.data.channelMoves
        .filter(m => m.channel === 'main')
        .slice(-1)
        .map(m => m.head),
    ])) {
      if (c.delta.trees ? !c.delta.trees.includes(head) : !parents.has(head)) continue;
      const files = trees.get(head);
      if (
        !files ||
        new Set(files.map(f => f.path)).size !== files.length ||
        files.some(f => !safeRelative(f.path) || !pins.has(f.blob))
      )
        return { reason: 'tree-invalid' };
      rows.push(...sourceTreeEntries(head, files));
    }
    return { rows };
  } catch (error) {
    return { reason: `payload-invalid:${error instanceof Error ? error.message : String(error)}` };
  }
}
const unique = (items: readonly (readonly [string, ...unknown[]])[]) =>
  new Set(items.map(([key]) => key)).size === items.length;
function validPins(value: unknown, pins: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => {
    if (
      ['blob', 'head', 'base', 'parent'].includes(key) &&
      typeof child === 'string' &&
      /^[a-f0-9]{64}$/.test(child) &&
      !pins.has(child)
    )
      return false;
    return validPins(child, pins);
  });
}

function unpack(row: IndexEntry, rows: IndexEntry[]) {
  const value = JSON.parse(row.value);
  if (!value.payloadKey) return value;
  if (!Number.isSafeInteger(value.payloadParts) || value.payloadParts < 1 || value.payloadParts > rows.length)
    throw Error('Incomplete derived payload');
  const chunks = rows
    .filter(r => r.collection === `${row.collection}:payload` && r.parent === value.payloadKey)
    .sort((a, b) => a.position - b.position);
  if (
    chunks.length !== value.payloadParts ||
    chunks.some((r, i) => r.position !== i || r.key !== `${value.payloadKey}:${i}`)
  )
    throw Error('Incomplete derived payload');
  const payload = chunks.map(r => r.value).join('');
  if (value.payloadKey !== `${row.key}:${digest(payload)}`) throw Error('Changed derived payload');
  return JSON.parse(payload);
}

export const CLI_UPGRADE_MESSAGE =
  'This push requires owner display protocol 3. Upgrade nforge with `npm install -g /path/to/current/nanthai-forge.tgz`, then prepare a new push. Existing hosted reads remain available.';
export function requireOwnerDerived(value: unknown) {
  invariant(
    value && typeof value === 'object' && (value as { schema?: unknown }).schema === 3,
    'CLI_UPGRADE_REQUIRED',
    CLI_UPGRADE_MESSAGE,
  );
}
/** Check size/hash before parsing; each continuation page has its own pin. */
export async function readOwnerDerived(
  pin: { sha256: string; size: number } | undefined,
  read: () => Promise<Buffer>,
  readPages?: (pins: { sha256: string; size: number }[]) => Promise<Buffer[]>,
): Promise<unknown> {
  invariant(pin, 'CLI_UPGRADE_REQUIRED', CLI_UPGRADE_MESSAGE);
  invariant(
    Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= OWNER_DERIVED_MAX_BYTES,
    'INVALID_OWNER_DATA',
    'Owner display root size is out of bounds.',
  );
  try {
    const bytes = await read();
    invariant(
      bytes.length === pin.size && digest(bytes) === pin.sha256,
      'INVALID_OWNER_DATA',
      'Owner display root hash or size changed.',
    );
    const value = await resolveOwnerDerived(
      bytes,
      readPages ??
        (async () => {
          throw Error('Missing display pages');
        }),
    );
    requireOwnerDerived(value);
    return value;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.log('owner-derived read invalid', { reason });
    throw new ForgeError('INVALID_OWNER_DATA', `Invalid owner display document or page (${reason}).`);
  }
}
