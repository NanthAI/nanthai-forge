// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { type Exchange, type Selected } from './projectWorkIndexBuildTypes';
import { buildLookups } from './projectWorkIndexBuildLookup';
import { exchangeObjectReader } from './projectExchangeReader';
import type { RecordPin } from '../src/work-exchange-records';
/** Invocation-local metadata and bounded immutable bytes. The next invocation
 * reparses its freshly authorized checkpoint; no access decision is memoized. */
export function buildContext(ctx: ActionCtx, selected: Selected, exchange: Exchange) {
  const catalogs = new Map(
    exchange.records.fields.flatMap(f =>
      'records' in f ? [[f.name, new Map(f.records.map(p => [p.key, p]))] as const] : [],
    ),
  );
  const pins = new Map(
    exchange.manifest.files.filter(p => p.path === `objects/${p.sha256}`).map(p => [p.sha256, p]),
  );
  const reader = exchangeObjectReader(ctx, false, 0);
  const bodies = new Map<string, Buffer>();
  let retained = 0;
  const remember = (pin: RecordPin, bytes: Buffer) => {
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
    prefetch,
    exchange: {
      ...exchange,
      read: async (pin: RecordPin) => {
        const bytes = bodies.get(pin.sha256);
        if (bytes) return bytes;
        const value = await exchange.read(pin);
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
