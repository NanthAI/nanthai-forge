// SPDX-License-Identifier: Apache-2.0
'use node';
import { indexReadContext, indexObjectRead } from './projectWorkIndexRetry';
import type { ActionCtx } from './_generated/server';
import { type Exchange, type Selected } from './projectWorkIndexBuildTypes';
import { buildLookups } from './projectWorkIndexBuildLookup';
import { exchangeObjectReader } from './projectExchangeReader';
import { diffstatPageSchema, ownerViewPageSchema, type DisplayStats } from '../src/owner-diffstats';
import { invariant } from '../src/errors';
import type { RecordPin } from '../src/work-exchange-records';
/** Invocation-local metadata and bounded immutable bytes. The next invocation
 * reparses its freshly authorized checkpoint; no access decision is memoized. */
export function buildContext(ctx: ActionCtx, selected: Selected, exchange: Exchange) {
  ctx = indexReadContext(ctx);
  const catalogs = new Map(
    exchange.records.fields.flatMap(f =>
      'records' in f ? [[f.name, new Map(f.records.map(p => [p.key, p]))] as const] : [],
    ),
  );
  // Pins cross Convex argument validators that accept exactly { sha256, size }.
  const pins = new Map(
    exchange.manifest.files
      .filter(p => p.path === `objects/${p.sha256}`)
      .map(p => [p.sha256, { sha256: p.sha256, size: p.size }]),
  );
  const reader = exchangeObjectReader(ctx, false, 0);
  const bodies = new Map<string, Buffer>();
  let retained = 0;
  const remember = (pin: { sha256: string; size: number }, bytes: Buffer) => {
    if (pin.size > 2 * 1024 * 1024 || bodies.has(pin.sha256)) return;
    while (retained + pin.size > 2 * 1024 * 1024) {
      const key = bodies.keys().next().value!;
      retained -= bodies.get(key)!.length;
      bodies.delete(key);
    }
    bodies.set(pin.sha256, bytes);
    retained += bytes.length;
  };
  const prefetch = async (requested: RecordPin[]) => {
    const pending = [
      ...new Map(requested.filter(p => !bodies.has(p.sha256)).map(p => [p.sha256, p])).values(),
    ];
    for (let offset = 0; offset < pending.length;) {
      const page: RecordPin[] = [];
      let bytes = 0;
      while (offset < pending.length && page.length < 100) {
        const pin = pending[offset]!;
        if (page.length && bytes + pin.size > 256 * 1024) break;
        page.push(pin);
        bytes += pin.size;
        offset++;
      }
      const values = await reader.read(selected.projectId, selected.owner, page);
      page.forEach((pin, i) => remember(pin, values[i]!));
    }
  };
  let main: Promise<(string | null)[]> | undefined;
  return {
    catalogs,
    pins,
    ownerViews: async (ids: string[]) => {
      const pages = exchange.root?.schema === 2 ? (exchange.root.ownerViews ?? []) : [];
      const selectedPages = pages.filter(p => ids.includes(p.key));
      const result = new Map<string, ReturnType<typeof ownerViewPageSchema.parse>['view']>();
      for (let offset = 0; offset < selectedPages.length;) {
        const page: typeof selectedPages = [];
        let size = 0;
        while (offset < selectedPages.length) {
          const pin = selectedPages[offset]!;
          if (page.length && size + pin.size > 2 * 1024 * 1024) break;
          page.push(pin);
          size += pin.size;
          offset++;
        }
        const loaded = await reader.read(
          selected.projectId,
          selected.owner,
          page.map(({ sha256, size }) => ({ sha256, size })),
        );
        for (const [i, pin] of page.entries()) {
          const value = ownerViewPageSchema.parse(JSON.parse(loaded[i]!.toString('utf8')));
          invariant(
            value.work === exchange.records.work.sha256 && value.view[0] === pin.key,
            'INVALID_OWNER_DATA',
            'Owner View selects another Work or View.',
          );
          result.set(pin.key, value.view);
        }
      }
      return result;
    },
    ownerStats: async (keys: string[]) => {
      const result = new Map<string, DisplayStats>();
      const pages = exchange.root?.schema === 2 ? (exchange.root.ownerDiffstats ?? []) : [];
      const selectedPages = pages.filter(p => keys.some(key => key >= p.first && key <= p.last));
      await prefetch(selectedPages.map(p => ({ sha256: p.sha256, size: p.size, key: p.first, refs: [] })));
      for (const page of selectedPages) {
        const pin = { sha256: page.sha256, size: page.size };
        const bytes =
          bodies.get(pin.sha256) ?? (await reader.read(selected.projectId, selected.owner, [pin]))[0]!;
        const value = diffstatPageSchema.parse(JSON.parse(bytes.toString('utf8')));
        invariant(
          value.work === exchange.records.work.sha256,
          'INVALID_OWNER_DATA',
          'Owner diffstats select another Work.',
        );
        for (const [key, stats] of value.stats)
          if (keys.includes(key))
            result.set(key, { ...stats, provenance: 'owner-reported', exact: stats.add !== undefined });
      }
      return result;
    },
    prefetch,
    exchange: {
      ...exchange,
      read: async (pin: RecordPin) => {
        const bytes = bodies.get(pin.sha256);
        if (bytes) return bytes;
        const value = await indexObjectRead(ctx, pin, () => exchange.read(pin));
        remember(pin, value);
        return value;
      },
    } as Exchange,
    main: () =>
      (main ??= buildLookups(ctx, selected, [
        { collection: 'hostedChannels', key: 'main' },
        { collection: 'channels', key: 'main' },
      ]).then(rows => rows.map(row => (row ? (JSON.parse(row.value).head as string) : null)))),
  };
}
export type BuildContext = ReturnType<typeof buildContext>;
