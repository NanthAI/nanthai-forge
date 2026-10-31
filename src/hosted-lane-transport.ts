// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';
import type { ConvexExchange } from './exchange-client.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import type { ContentPin } from './native-exchange.js';
import type { LaneTransport } from './hosted-lane-checkout.js';
import { hostedDownloadPageSize, type HostedDownloadDescriptor } from './hosted-download-page.js';
import { readSigned, type SignedObject } from './exchange-r2-read.js';
import { invariant } from './errors.js';
import { latestClientSourcePack } from './source-pack-client.js';
/** Reuse project-scoped membership, batched R2 signing and dual-location byte transport. */
export class ConvexLaneTransport implements LaneTransport {
  readonly objectPageSize = hostedDownloadPageSize;
  private descriptors = new Map<string, HostedDownloadDescriptor>();
  constructor(
    private readonly exchange: Pick<
      ConvexExchange,
      | 'client'
      | 'projectId'
      | 'downloadToFile'
      | 'downloadBatch'
      | 'prepareDownloads'
      | 'onCall'
      | 'onDownloadProgress'
    >,
  ) {}
  sourcePack() {
    return latestClientSourcePack(this.exchange.client as never, this.exchange.projectId);
  }
  async select(laneId: string) {
    return hostedLaneSelectionSchema.parse(
      JSON.parse(
        await this.exchange.client.query(makeFunctionReference<'query'>('projectHostedLanes:select'), {
          projectId: this.exchange.projectId,
          laneId,
        }),
      ),
    );
  }
  private async page(digests: string[], signed: boolean): Promise<HostedDownloadDescriptor[]> {
    const rows: HostedDownloadDescriptor[] = await this.exchange.client.mutation(
      makeFunctionReference<'mutation'>('projectObjectDownloads:lanePage'),
      { projectId: this.exchange.projectId, digests, signed },
    );
    invariant(
      rows.length === digests.length && rows.every((row, index) => row.digest === digests[index]),
      'INVALID_WORK_BACKUP',
      'Download descriptors differ from the selected content.',
    );
    return rows;
  }
  async objects(digests: string[]) {
    const rows = await this.page(digests, true);
    this.descriptors = new Map(rows.map(row => [row.digest, row]));
    return rows.map(row => ({ sha256: row.digest, size: row.size }));
  }
  downloadToFile(pin: ContentPin, path: string) {
    return this.exchange.downloadToFile(pin, path);
  }
  async downloadFiles(files: { pin: ContentPin; path: string }[]) {
    if (files.length > this.objectPageSize) {
      for (let at = 0; at < files.length; at += this.objectPageSize)
        await this.downloadFiles(files.slice(at, at + this.objectPageSize));
      return;
    }
    if (files.some(file => !this.descriptors.has(file.pin.sha256)))
      await this.objects(files.map(file => file.pin.sha256));
    // Size discovery already fetched these signatures. Consume them once; a 403
    // refreshes through the same authorized endpoint, never an action per object.
    const signed = new Map<string, SignedObject>();
    for (const { pin } of files) {
      const row = this.descriptors.get(pin.sha256);
      invariant(row?.size === pin.size, 'INVALID_WORK_BACKUP', 'Download binding changed.');
      if (row.url) signed.set(row.digest, { ...row, url: row.url });
    }
    const direct = await readSigned(
      async (_projectId, digests) => {
        if (digests.every(id => signed.has(id))) {
          const rows = digests.map(id => signed.get(id)!);
          for (const id of digests) signed.delete(id);
          return rows;
        }
        return (await this.page(digests, true)).flatMap(row => (row.url ? [{ ...row, url: row.url }] : []));
      },
      this.exchange.projectId,
      files.filter(file => signed.has(file.pin.sha256)).map(file => file.pin),
      undefined,
      (pin, done) => this.exchange.onDownloadProgress?.(pin, done),
      (name, pending) => this.exchange.onCall?.(name, pending),
    );
    const legacy = files.filter(file => !direct.has(file.pin.sha256));
    const small = legacy.filter(file => file.pin.size <= 2 * 1024 * 1024);
    if (small.length) {
      const bytes = await this.exchange.downloadBatch(small.map(file => file.pin));
      for (let index = 0; index < small.length; index++)
        writeFileSync(small[index]!.path, bytes[index]!, { flag: 'wx', mode: 0o600 });
    }
    const large = legacy.filter(file => file.pin.size > 2 * 1024 * 1024);
    if (large.length) await this.exchange.prepareDownloads(large.map(file => file.pin));
    for (const file of large) await this.downloadToFile(file.pin, file.path);
    if (direct.size) {
      const rows = await this.page(
        files.map(file => file.pin.sha256),
        false,
      );
      invariant(
        rows.every((row, index) => row.size === files[index]!.pin.size),
        'INVALID_WORK_BACKUP',
        'Download binding changed during transfer.',
      );
      for (const { pin, path } of files) {
        const bytes = direct.get(pin.sha256);
        if (bytes) writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    for (const { pin } of files) this.descriptors.delete(pin.sha256);
  }
}
