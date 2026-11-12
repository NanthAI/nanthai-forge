// SPDX-License-Identifier: Apache-2.0
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import type { NativeFile } from './state/format.js';
import { checkoutIo } from './checkout-io.js';
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
import { readCompleteRuns, runGroups, type PackRunBinding } from './hosted-checkout-runs.js';
type Descriptor = HostedDownloadDescriptor & { run?: PackRunBinding };
/** Older servers reject the `runs` argument; their pages keep a signature per object. */
const olderServer = (error: unknown) => /extra field `?runs/.test(String((error as Error)?.message));
/** Reuse project-scoped membership, batched R2 signing and dual-location byte transport. */
export class ConvexLaneTransport implements LaneTransport {
  readonly objectPageSize = hostedDownloadPageSize;
  private readonly descriptors = new Map<string, Descriptor>();
  private runs = true;
  private pages = 0;
  private stateDownloads: HostedCheckoutDownloads | undefined;
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
    > & { sourceStateReads?: boolean; sourceStateVersion?: 1 | 2 },
  ) {}
  selectState(state: string, files: readonly NativeFile[]) {
    const physical = this.descriptors.get(state)?.statePhysical;
    if (!this.exchange.sourceStateReads || !physical) {
      this.stateDownloads = undefined;
      return;
    }
    this.stateDownloads ??= new HostedCheckoutDownloads(this.exchange);
    this.stateDownloads.selectState(state, files, physical);
  }
  prepareObjects(ids: string[]) {
    return this.stateDownloads?.prepareObjects(ids) ?? Promise.resolve(null);
  }
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
  private async page(digests: string[], signed: boolean, runs = false): Promise<Descriptor[]> {
    type Wire = HostedDownloadDescriptor & { run?: Omit<PackRunBinding, 'key'> & { id: number } };
    const call = (withRuns: boolean): Promise<Wire[]> =>
      this.exchange.client.mutation(
        makeFunctionReference<'mutation'>('projectObjectDownloads:lanePage'),
        {
          projectId: this.exchange.projectId,
          digests,
          signed,
          ...(this.exchange.sourceStateReads
            ? { stateSource: this.exchange.sourceStateVersion === 2 ? 2 : true }
            : {}),
          ...(withRuns ? { runs: true } : {}),
        },
        { skipQueue: true },
      ); // Signing writes nothing; pages described ahead run alongside.
    let rows;
    if (runs && signed && this.runs && digests.length > 1)
      try {
        rows = await call(true);
      } catch (error) {
        if (!olderServer(error)) throw error;
        this.runs = false;
      }
    rows ??= await call(false);
    invariant(
      rows.length === digests.length &&
        rows.every((row, index) => row.digest === digests[index] && (!signed || !row.run || row.range)),
      'INVALID_WORK_BACKUP',
      'Download descriptors differ from the selected content.',
    );
    const page = this.pages++;
    return rows.map(({ run, ...row }) => (run ? { ...row, run: { ...run, key: `${page}:${run.id}` } } : row));
  }
  async objects(digests: string[]) {
    if (this.stateDownloads) return this.stateDownloads.objects(digests);
    const rows = await this.page(digests, true, true);
    // Merge: the checkout cache describes later pages while an earlier one downloads.
    for (const row of rows) this.descriptors.set(row.digest, row);
    return rows.map(row => ({ sha256: row.digest, size: row.size }));
  }
  /** Keep each pack run inside one download window. */
  downloadGroups(pins: ContentPin[]) {
    if (this.stateDownloads) return this.stateDownloads.downloadGroups(pins);
    return runGroups(pins, digest => this.descriptors.get(digest));
  }
  downloadToFile(pin: ContentPin, path: string) {
    if (this.stateDownloads) return this.stateDownloads.downloadToFile(pin, path);
    return this.exchange.downloadToFile(pin, path);
  }
  async downloadFiles(files: { pin: ContentPin; path: string }[]) {
    if (this.stateDownloads) return this.stateDownloads.downloadFiles(files);
    if (files.length > this.objectPageSize) {
      for (let at = 0; at < files.length; at += this.objectPageSize)
        await this.downloadFiles(files.slice(at, at + this.objectPageSize));
      return;
    }
    if (files.some(file => !this.descriptors.has(file.pin.sha256)))
      await this.objects(files.map(file => file.pin.sha256));
    // Whole pack runs first (one ranged GET each); their members are checked below with the rest.
    const runs = await readCompleteRuns(files, this.descriptors);
    // Run members left over (a run split across calls, or an expired run grant) are signed on their own.
    const unsigned = files.filter(
      file => !runs.has(file.pin.sha256) && this.descriptors.get(file.pin.sha256)?.run,
    );
    if (unsigned.length)
      for (const row of await this.page(
        unsigned.map(file => file.pin.sha256),
        true,
      ))
        this.descriptors.set(row.digest, row);
    // Size discovery already fetched these signatures. Consume them once; a 403
    // refreshes through the same authorized endpoint, never an action per object.
    const signed = new Map<string, SignedObject>();
    for (const { pin } of files) {
      const row = this.descriptors.get(pin.sha256);
      invariant(row?.size === pin.size, 'INVALID_WORK_BACKUP', 'Download binding changed.');
      if (row.closure) signed.set(row.digest, { digest: row.digest, size: row.size, closure: row.closure });
      else if (row.url && !runs.has(row.digest))
        signed.set(row.digest, {
          digest: row.digest,
          size: row.size,
          url: row.url,
          ...(row.range ? { range: row.range } : {}),
        });
    }
    const direct = await readSigned(
      async (_projectId, digests) => {
        if (digests.every(id => signed.has(id))) {
          const rows = digests.map(id => signed.get(id)!);
          for (const id of digests) signed.delete(id);
          return rows;
        }
        return (await this.page(digests, true)).flatMap((row): SignedObject[] =>
          row.closure
            ? [{ digest: row.digest, size: row.size, closure: row.closure }]
            : row.url
              ? [
                  {
                    digest: row.digest,
                    size: row.size,
                    url: row.url,
                    ...(row.range ? { range: row.range } : {}),
                  },
                ]
              : [],
        );
      },
      this.exchange.projectId,
      files.filter(file => signed.has(file.pin.sha256)).map(file => file.pin),
      undefined,
      (pin, done) => this.exchange.onDownloadProgress?.(pin, done),
      (name, pending) => this.exchange.onCall?.(name, pending),
    );
    const legacy = files.filter(file => !direct.has(file.pin.sha256) && !runs.has(file.pin.sha256));
    const small = legacy.filter(file => file.pin.size <= 2 * 1024 * 1024);
    if (small.length) {
      const bytes = await this.exchange.downloadBatch(small.map(file => file.pin));
      for (let index = 0; index < small.length; index++)
        await checkoutIo(async () =>
          writeFileSync(small[index]!.path, bytes[index]!, { flag: 'wx', mode: 0o600 }),
        );
    }
    const large = legacy.filter(file => file.pin.size > 2 * 1024 * 1024);
    if (large.length) await this.exchange.prepareDownloads(large.map(file => file.pin));
    for (const file of large) await this.downloadToFile(file.pin, file.path);
    if (direct.size || runs.size) {
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
        if (bytes) await checkoutIo(async () => writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }));
      }
    }
    for (const { pin } of files) this.descriptors.delete(pin.sha256);
  }
}
