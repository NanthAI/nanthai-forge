// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';
import type { ConvexExchange } from './exchange-client.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import type { ContentPin } from './native-exchange.js';
import type { LaneTransport } from './hosted-lane-checkout.js';
/** Reuse project-scoped membership, batched R2 signing and dual-location byte transport. */
export class ConvexLaneTransport implements LaneTransport {
  constructor(
    private readonly exchange: Pick<
      ConvexExchange,
      'client' | 'projectId' | 'objects' | 'downloadToFile' | 'downloadBatch' | 'prepareDownloads'
    >,
  ) {}
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
  objects(digests: string[]) {
    return this.exchange.objects(digests);
  }
  downloadToFile(pin: ContentPin, path: string) {
    return this.exchange.downloadToFile(pin, path);
  }
  async downloadFiles(files: { pin: ContentPin; path: string }[]) {
    const small = files.filter(file => file.pin.size <= 2 * 1024 * 1024);
    if (small.length) {
      const bytes = await this.exchange.downloadBatch(small.map(file => file.pin));
      for (let index = 0; index < small.length; index++)
        writeFileSync(small[index]!.path, bytes[index]!, { flag: 'wx', mode: 0o600 });
    }
    const large = files.filter(file => file.pin.size > 2 * 1024 * 1024);
    if (large.length) await this.exchange.prepareDownloads(large.map(file => file.pin));
    for (const file of large) await this.downloadToFile(file.pin, file.path);
  }
}
