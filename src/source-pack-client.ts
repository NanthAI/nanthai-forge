// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { sourcePackDownloadSchema, type SourcePackDownload } from './source-pack.js';
import { createSourcePack } from './source-pack-archive.js';
import { parseNativeState } from './native-state-format.js';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
import { invariant } from './errors.js';

type Client = {
  mutation(reference: never, args: Record<string, unknown>): Promise<unknown>;
  action(reference: never, args: Record<string, unknown>): Promise<unknown>;
};
/** One signed GET for the project's pack. Older servers lack the function and any failure
 * means "no pack": the caller then reads objects as before. */
export async function latestClientSourcePack(
  client: Pick<Client, 'mutation'>,
  projectId: string,
): Promise<SourcePackDownload | null> {
  try {
    const value = await client.mutation(
      makeFunctionReference<'mutation'>('projectSourcePackClient:latest') as never,
      { projectId },
    );
    const pack = sourcePackDownloadSchema.safeParse(value);
    return pack.success ? pack.data : null;
  } catch {
    return null;
  }
}

/** Operator repair/backfill: pack the current hosted main from this machine's verified
 * objects (fetched through the pack/machine/object path) and publish it to R2. */
export async function publishClientSourcePack(input: {
  client: Client;
  projectId: string;
  head: string;
  cacheRoot: string;
  transport: CheckoutObjectTransport;
  request?: typeof fetch;
}) {
  const started = Date.now();
  const latest = await latestClientSourcePack(input.client, input.projectId);
  if (latest?.stateRef === input.head)
    return {
      status: 'current' as const,
      stateRef: input.head,
      size: latest.size,
      fileCount: latest.fileCount,
    };
  const cache = new HostedCheckoutCache(input.cacheRoot, input.transport);
  await cache.ensure([input.head]);
  const state = parseNativeState(readFileSync(join(cache.objects, input.head)));
  await cache.ensure(state.files.map(file => file.blob));
  const temporary = mkdtempSync(join(cache.root, 'publish-'));
  try {
    const archive = join(temporary, 'pack.gz');
    const object = await createSourcePack(input.head, state, cache.objects, archive);
    invariant(
      object,
      'SOURCE_PACK_TOO_LARGE',
      'This tree exceeds the source pack bounds (300 MB packed, 32 MB per file).',
    );
    const publish = makeFunctionReference<'action'>('projectSourcePackClient:publish') as never;
    const data = { projectId: input.projectId, object: JSON.stringify(object) };
    const target = (await input.client.action(publish, { ...data, phase: 'prepare' })) as {
      url: string;
      headers: Record<string, string>;
    } | null;
    if (target) {
      const response = await (input.request ?? fetch)(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: createReadStream(archive),
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.timeout(900_000),
      } as unknown as RequestInit);
      invariant(response.ok || response.status === 412, 'R2_UPLOAD_FAILED', 'Pack upload failed.');
      await input.client.action(publish, { ...data, phase: 'commit' });
    }
    return {
      status: target ? ('published' as const) : ('unchanged' as const),
      ...object,
      downloadedObjects: cache.downloadedObjects,
      packObjects: cache.packObjects,
      machineObjects: cache.machineObjects,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
