// SPDX-License-Identifier: Apache-2.0
import type { ConvexReactClient } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import { saveBytes, savePin } from '../../../src/hosted-save';
import { digest } from '../../../src/portable-hash';
import { invariant } from '../../../src/errors';
import type { LandingIO, Pin } from './hosted-landing-client';
export function landingBrowserIO(client: ConvexReactClient, projectId: Id<'hostedProjects'>): LandingIO {
  const parse = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
  const io: LandingIO = {
    query: async (name, args) =>
      parse(await client.query(makeFunctionReference<'query'>(name), { ...args, projectId })),
    mutation: async (name, args) =>
      parse(await client.mutation(makeFunctionReference<'mutation'>(name), { ...args, projectId })),
    wait: (name, args, done) =>
      new Promise((resolve, reject) => {
        const watch = client.watchQuery(makeFunctionReference<'query'>(name), { ...args, projectId });
        let stop = () => {};
        const update = () => {
          try {
            const value = watch.localQueryResult();
            if (value !== undefined) {
              const parsed = parse(value);
              if (done(parsed as never)) {
                stop();
                resolve(parsed as never);
              }
            }
          } catch (error) {
            stop();
            reject(error);
          }
        };
        stop = watch.onUpdate(update);
        update();
      }),
    read: async (pin: Pin) => {
      const [row] = await client.mutation(api.projectObjectDownloads.describe, {
        projectId,
        digests: [pin.sha256],
      });
      invariant(
        row && row.size === pin.size && row.location !== 'recipe',
        'SOURCE_UNAVAILABLE',
        'Exact composition metadata is unavailable.',
      );
      const url =
        row.location === 'convex'
          ? row.url
          : (
              await client.mutation(api.projectObjectDownloads.signDownloads, {
                projectId,
                digests: [pin.sha256],
              })
            )[0]?.url;
      invariant(url, 'SOURCE_UNAVAILABLE', 'Exact metadata download is unavailable.');
      const response = await fetch(url);
      invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Metadata download failed.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Metadata differs from its exact pin.',
      );
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    upload: async value => {
      const pin = savePin(value),
        blob = new Blob([new Uint8Array(saveBytes(value)).buffer]);
      const prepared = await client.mutation(api.projectObjects.prepare, {
        projectId,
        digest: pin.sha256,
        size: pin.size,
      });
      if (prepared.stored) return;
      invariant(prepared.target, 'SOURCE_UNAVAILABLE', 'Metadata upload is unavailable.');
      const headers = Object.fromEntries(
        Object.entries(prepared.target.headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
      );
      const response = await fetch(prepared.target.url, { method: 'PUT', headers, body: blob });
      invariant(response.ok || response.status === 412, 'SOURCE_UNAVAILABLE', 'Metadata upload failed.');
      await client.action(api.projectObjectCommit.commitBatch, { objects: [{ id: prepared.id }] });
    },
  };
  return io;
}
