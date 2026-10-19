// SPDX-License-Identifier: Apache-2.0
'use node';
import { ownerDerivedSchema, viewFingerprint, OWNER_DERIVED_MAX_BYTES } from '../src/owner-derived';
import { digest } from '../src/hash';
import { stateParentEntries } from '../src/source-state-parent-index';
import { sourceTreeEntries } from '../src/source-tree-index';
import { viewIndexEntries } from '../src/view-hosted-index';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Cursor } from './projectSourceReturnStep';
import type { IndexEntry } from '../src/work-hosted-index';

/** Metadata-only validation. Failure is an optimization miss, never a source denial. */
export function ownerDerivedRows(c: Cursor, value: unknown): IndexEntry[] | undefined {
  try {
    if (!c.delta || Buffer.byteLength(JSON.stringify(value)) > OWNER_DERIVED_MAX_BYTES) return;
    const parsed = ownerDerivedSchema.safeParse(value);
    if (!parsed.success) return;
    const d = parsed.data,
      pins = new Set(
        c.snapshot.manifest.files.filter(p => p.path === `objects/${p.sha256}`).map(p => p.sha256),
      );
    if (
      d.work !== JSON.parse(c.final.command).workSha256 ||
      !unique(d.parents) ||
      !unique(d.ancestry) ||
      !unique(d.stats) ||
      !unique(d.views) ||
      !unique(d.trees)
    )
      return;
    for (const [head, parents] of [...d.parents, ...d.ancestry])
      if (!pins.has(head) || parents.some(p => !pins.has(p))) return;
    for (const [key] of d.stats)
      if (key.split(':').length !== 2 || key.split(':').some(p => !pins.has(p))) return;
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
      if (!list) return;
      rows.push(...stateParentEntries(head, list));
      pending.push(...list);
    }
    // Every new State supplies only itself and references to its parents. Readers
    // compose these boundaries with existing closures/parent caches on demand.
    for (const [head, list] of d.ancestry) {
      if (JSON.stringify(parents.get(head)) !== JSON.stringify(list)) return;
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
    for (const head of c.heads) if (!closures.has(head) && !c.delta.stopParents.includes(head)) return;
    for (const record of c.diffstats?.records ?? []) {
      const value = JSON.parse(record.value),
        key = `${value.base}:${value.head}`;
      if (!value.head || value.status === 'conflict') {
        rows.push(record);
        continue;
      }
      const changes = stats.get(key);
      if (!changes || (changes.add === undefined) !== (changes.del === undefined)) return;
      rows.push({ ...record, value: JSON.stringify({ ...value, changes }) });
      if (!rows.some(r => r.collection === 'diffstats' && r.key === key))
        rows.push({ collection: 'diffstats', key, parent: '', position: 0, value: JSON.stringify(changes) });
    }
    for (const index of c.delta.views) {
      const view = c.snapshot.data.views[index]!,
        supplied = views.get(view.id);
      if (!supplied || supplied.fingerprint !== viewFingerprint(c.snapshot.data, index)) return;
      const ids = new Set<string>();
      for (const row of supplied.rows) {
        const identity = JSON.stringify([row.collection, row.key]);
        if (ids.has(identity)) return;
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
          return;
        if (row.collection.startsWith('viewFiles') && !row.key.startsWith(`${view.id}:`)) return;
        if (row.collection.endsWith(':payload')) {
          if (
            !supplied.rows.some(
              header =>
                header.collection === row.collection.slice(0, -8) &&
                JSON.parse(header.value).payloadKey === row.parent,
            )
          )
            return;
        } else if (!validPins(unpack(row, supplied.rows), pins)) return;
      }
      const detail = supplied.rows.find(r => r.collection === 'viewDetails' && r.key === view.id);
      if (!detail) return;
      const summary = unpack(detail, supplied.rows);
      const fileRows = supplied.rows.filter(r => r.collection === 'viewFiles');
      if (
        typeof summary.provenanceAvailable !== 'boolean' ||
        (summary.fileCount !== null &&
          (!Number.isSafeInteger(summary.fileCount) ||
            summary.fileCount < 0 ||
            summary.fileCount !== fileRows.length))
      )
        return;
      if (
        view.status === 'conflict'
          ? summary.fileCount !== null || summary.provenanceAvailable
          : !summary.provenanceAvailable
      )
        return;
      for (const fileRow of fileRows) {
        const file = unpack(fileRow, supplied.rows);
        if (
          fileRow.parent !== view.id ||
          fileRow.key !== `${view.id}:${file.path}` ||
          !['added', 'deleted', 'modified'].includes(file.status) ||
          typeof file.historyComplete !== 'boolean' ||
          !Array.isArray(file.contributors)
        )
          return;
        for (const version of [file.before, file.after])
          if (
            version !== null &&
            (!version ||
              typeof version.path !== 'string' ||
              !pins.has(version.blob) ||
              !['file', 'executable', 'symlink'].includes(version.mode))
          )
            return;
      }
      const expected = viewIndexEntries(c.snapshot.data, undefined, {
        index,
        positions: new Map(),
        cachedProvenance: { fileCount: summary.fileCount, provenanceAvailable: summary.provenanceAvailable },
      });
      if (
        JSON.stringify(supplied.rows.filter(r => !r.collection.startsWith('viewFiles'))) !==
        JSON.stringify(expected)
      )
        return;
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
        files.some(f => !pins.has(f.blob))
      )
        return;
      rows.push(...sourceTreeEntries(head, files));
    }
    return rows;
  } catch {
    return undefined;
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

/** Keep validated rows private until the original return cursor publishes them. */
export async function installOwnerDerived(ctx: ActionCtx, c: Cursor, value: unknown) {
  const supplied = ownerDerivedRows(c, value);
  if (supplied) {
    for (const index of c.delta!.views) {
      const view = c.snapshot.data.views[index]!;
      const keys = new Set(supplied.filter(r => r.collection === 'viewFiles').map(r => r.key));
      let cursor: string | null = null;
      do {
        const page: { entries: import('../src/work-hosted-index').IndexEntry[]; cursor: string | null } =
          await ctx.runQuery(internal.projectWorkIndexStore.viewFiles, {
            projectId: c.final.projectId,
            owner: c.final.owner,
            generationId: c.generationId,
            viewId: view.id,
            cursor,
          });
        for (const old of page.entries)
          if (!keys.has(old.key)) {
            c.delta!.removed.push({ collection: old.collection, key: old.key });
            c.delta!.readBytes += Buffer.byteLength(JSON.stringify(old)) + 2048;
            c.metadata!.counts.viewFiles!--;
          }
        cursor = page.cursor;
      } while (cursor !== null);
    }
    c.rows.push(...supplied);
    c.phase = 'done';
    c.pending = [];
    c.parents = [];
    delete c.diffstats;
  }
}

/** Reject the declared size before any object read (including legacy retry pins). */
export async function readOwnerDerived(
  pin: { sha256: string; size: number } | undefined,
  read: () => Promise<Buffer>,
): Promise<unknown> {
  if (!pin || !Number.isSafeInteger(pin.size) || pin.size < 1 || pin.size > OWNER_DERIVED_MAX_BYTES) return;
  try {
    const bytes = await read();
    if (bytes.length !== pin.size || bytes.length > OWNER_DERIVED_MAX_BYTES || digest(bytes) !== pin.sha256)
      return;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}
