import { pageHashes, readRecordValue, readWorkFile, recordManifest } from './work-records.js';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { nativeOwner } from './native-source.js';
import { hostedAgentAddressSchema } from './hosted-agent-contract.js';
// SPDX-License-Identifier: Apache-2.0
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';
/** Explicit migration only. Pins one immutable Work manifest and buffers <=100
 * records, never load() or network calls per record. Lead runs --apply. */
export async function importBoundRecords(
  selected: string | { root: string },
  apply = false,
  supplied?: Pick<HostedAgentTransport, 'query' | 'mutation'>,
) {
  const root = nativeOwner(realpathSync(typeof selected === 'string' ? selected : selected.root));
  invariant(root, 'BAD_ARGUMENT', 'Import requires a bound native owner.');
  const directory = join(root, '.forge', 'work');
  const binding = JSON.parse(readFileSync(join(directory, 'hosted-binding.json'), 'utf8')).binding;
  const address = hostedAgentAddressSchema.parse({ url: binding?.deployment, projectId: binding?.projectId });
  const pointer = readWorkFile(directory);
  const manifest = pointer ? recordManifest(JSON.parse(pointer.toString('utf8'))) : undefined;
  invariant(
    manifest && manifest.schema !== 'forge-work-records-v1',
    'INVALID_WORK_STORE',
    'Import requires indexed native Work.',
  );
  const transport = supplied ?? new HostedAgentTransport(root, address);
  const totals = {
    dryRun: !apply,
    calls: 0,
    records: 0,
    existing: 0,
    added: 0,
    maxBufferedRecords: 0,
    maxBufferedBytes: 0,
    revision: manifest.fields.revision,
  };
  for (const [collection, field] of [
    ['frictionEvents', 'friction'],
    ['decisions', 'decisions'],
  ] as const) {
    const index = manifest.collections[collection];
    if (!index) continue;
    let page: unknown[] = [],
      bytes = 0;
    const send = async () => {
      if (!page.length) return;
      totals.maxBufferedRecords = Math.max(totals.maxBufferedRecords, page.length);
      const request = canonicalPayload({ [field]: page });
      totals.maxBufferedBytes = Math.max(totals.maxBufferedBytes, Buffer.byteLength(request));
      const response = (await (apply ? transport.mutation : transport.query).call(
        transport,
        `projectHostedFrictionImport:${apply ? 'apply' : 'preview'}`,
        { request },
      )) as { records: number; existing: number; added: number };
      totals.calls++;
      totals.records += response.records;
      totals.existing += response.existing;
      totals.added += response.added;
      page = [];
      bytes = 0;
    };
    for (const hash of index.pages) {
      for (const id of pageHashes(directory, hash)) {
        const record = readRecordValue(directory, id, true);
        const size = Buffer.byteLength(JSON.stringify(record));
        // A byte target, not a record-size policy: a larger individual record is
        // still sent intact. Provider limits remain explicit server errors.
        if (page.length && (page.length === 100 || bytes + size > 512 * 1024)) await send();
        page.push(record);
        bytes += size;
      }
    }
    await send();
  }
  return totals;
}
