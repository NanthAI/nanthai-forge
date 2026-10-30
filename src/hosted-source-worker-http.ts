// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { readSourceControlReply } from './hosted-source-control-reply.js';
import { invariant } from './errors.js';
import type { SourceDispatch } from './hosted-source-job.js';
import type { HostedActionsTransfer } from './hosted-actions.js';
import { workerObjectSchema, type WorkerPin } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';

const grant = z.union([
  z.object({ url: z.url(), headers: z.record(z.string(), z.string()).default({}) }).strict(),
  z.object({ stored: z.literal(true) }).strict(),
]);
/** Fixed trusted ingress authorizes each pin using current job authority, then
 * returns exact R2 transfer URLs. It never proxies source bytes through Convex.
 * The grant ingress is provisioned with the source-operation reducers. */
export function sourceWorkerHttp(config: {
  endpoint: string;
  token: string;
  executionId: string;
  input: SourceDispatch | HostedActionsTransfer;
  timeoutMs: number;
  fetch?: typeof fetch;
}) {
  const base = new URL(config.endpoint);
  invariant(
    base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash,
    'SOURCE_WORKER_UNAVAILABLE',
    'Configure the trusted source-control ingress.',
  );
  const request = config.fetch ?? fetch;
  const control = async (action: string, value: unknown) => {
    const response = await request(new URL(action, base.href.endsWith('/') ? base : base.href + '/'), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    invariant(response.ok, 'SOURCE_WORKER_UNAVAILABLE', 'Source control request was not acknowledged.');
    return response;
  };
  const transfer = async (action: 'read' | 'upload', pin: WorkerPin) => {
    const response = await control('grant', {
      action,
      pin,
      input: config.input,
      executionId: config.executionId,
    });
    const value = grant.parse(await readSourceControlReply(response));
    if ('stored' in value) {
      invariant(action === 'upload', 'SOURCE_WORKER_UNAVAILABLE', 'A read requires an exact transfer URL.');
      return value;
    }
    const url = new URL(value.url);
    invariant(
      url.protocol === 'https:' && !url.username && !url.password && !url.hash,
      'SOURCE_WORKER_UNAVAILABLE',
      'Source transfer grant must use HTTPS.',
    );
    return { url, headers: value.headers };
  };
  const validGrant = (value: unknown) => {
    const parsed = grant.parse(value);
    if ('url' in parsed) {
      const url = new URL(parsed.url);
      invariant(
        url.protocol === 'https:' && !url.username && !url.password && !url.hash,
        'SOURCE_WORKER_UNAVAILABLE',
        'Source transfer grant must use HTTPS.',
      );
    }
    return parsed;
  };
  const identity = { input: config.input, executionId: config.executionId };
  const grants = async (action: 'read' | 'upload', pins: WorkerPin[]) => {
    const response = await control('grant-batch', { ...identity, action, pins });
    const values = z
      .array(z.unknown())
      .parse(await readSourceControlReply(response))
      .map(validGrant);
    invariant(values.length === pins.length, 'SOURCE_HASH_MISMATCH', 'Source transfer page is incomplete.');
    return values;
  };
  async function* download(target: ReturnType<typeof validGrant>) {
    invariant('url' in target, 'SOURCE_WORKER_UNAVAILABLE', 'A read requires an exact transfer URL.');
    const response = await request(target.url, {
      headers: target.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    invariant(response.ok && response.body, 'SOURCE_WORKER_UNAVAILABLE', 'Source transfer is unavailable.');
    yield* Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  }
  const readTarget = async (target: { url: string; headers: Record<string, string> }) => {
    const url = new URL(target.url);
    invariant(
      url.protocol === 'https:' && !url.username && !url.password && !url.hash,
      'SOURCE_WORKER_UNAVAILABLE',
      'Source transfer grant must use HTTPS.',
    );
    const response = await request(url, {
      headers: target.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    invariant(response.ok && response.body, 'SOURCE_WORKER_UNAVAILABLE', 'Source transfer is unavailable.');
    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  };
  const transport: SourceWorkerTransport = {
    async describeBatch(digests) {
      const response = await control('describe-batch', { ...identity, digests });
      const refs = z.array(workerObjectSchema).parse(await readSourceControlReply(response));
      invariant(
        refs.length === digests.length && refs.every((ref, index) => ref.object.sha256 === digests[index]),
        'SOURCE_HASH_MISMATCH',
        'Source descriptor page selected different content.',
      );
      return refs;
    },
    async readBatch(pins) {
      return (await grants('read', pins)).map(target => download(target));
    },
    async uploadBatch(objects) {
      const targets = await grants(
        'upload',
        objects.map(object => object.pin),
      );
      const pending: WorkerPin[] = [];
      for (const [index, object] of objects.entries()) {
        const target = targets[index]!;
        const hash = createHash('sha256');
        let size = 0;
        async function* verified() {
          for await (const chunk of object.bytes) {
            size += chunk.byteLength;
            invariant(
              size <= object.pin.size,
              'SOURCE_HASH_MISMATCH',
              'Output exceeds its exact committed size.',
            );
            hash.update(chunk);
            yield chunk;
          }
          invariant(
            size === object.pin.size && hash.digest('hex') === object.pin.sha256,
            'SOURCE_HASH_MISMATCH',
            'Output differs from its exact committed content.',
          );
        }
        if ('stored' in target) {
          for await (const chunk of verified()) void chunk;
          continue;
        }
        const init: RequestInit & { duplex: 'half' } = {
          method: 'PUT',
          body: Readable.from(verified()) as unknown as BodyInit,
          duplex: 'half',
          redirect: 'error',
          signal: AbortSignal.timeout(config.timeoutMs),
          headers: target.headers,
        };
        const response = await request(target.url, init);
        invariant(
          response.ok || response.status === 412,
          'SOURCE_WORKER_UNAVAILABLE',
          'Source upload was not acknowledged.',
        );
        // A create-only replay may return 412 without consuming its request body.
        // HEAD/commit still verifies the exact retained hash and size.
        pending.push(object.pin);
      }
      if (pending.length) await control('commit-batch', { ...identity, pins: pending });
    },
    async describe(sha256) {
      const response = await control('describe', {
        sha256,
        input: config.input,
        executionId: config.executionId,
      });
      const descriptor = workerObjectSchema.parse(await readSourceControlReply(response));
      invariant(
        descriptor.object.sha256 === sha256,
        'SOURCE_HASH_MISMATCH',
        'Source descriptor selected different content.',
      );
      return descriptor;
    },
    async read(pin) {
      const target = await transfer('read', pin);
      invariant('url' in target, 'SOURCE_WORKER_UNAVAILABLE', 'A read requires an exact transfer URL.');
      const response = await request(target.url, {
        headers: target.headers,
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      invariant(response.ok && response.body, 'SOURCE_WORKER_UNAVAILABLE', 'Source transfer is unavailable.');
      return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    },
    ...('kind' in config.input && config.input.kind === 'forge-hosted-actions'
      ? {
          async describeAndRead(sha256s: string[]) {
            const response = await control('describe-and-grant', {
              sha256s,
              input: config.input,
              executionId: config.executionId,
            });
            const entries = z
              .array(
                z
                  .object({
                    descriptor: workerObjectSchema,
                    target: z
                      .object({ url: z.url(), headers: z.record(z.string(), z.string()) })
                      .strict()
                      .nullable(),
                  })
                  .strict(),
              )
              .max(100)
              .parse(await readSourceControlReply(response));
            return entries.map(entry => ({
              descriptor: entry.descriptor,
              read: entry.target ? () => readTarget(entry.target!) : null,
            }));
          },
        }
      : {}),
    async upload(pin, bytes) {
      const target = await transfer('upload', pin);
      if ('stored' in target) {
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of bytes) {
          size += chunk.byteLength;
          invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Output exceeds its exact committed size.');
          hash.update(chunk);
        }
        invariant(
          size === pin.size && hash.digest('hex') === pin.sha256,
          'SOURCE_HASH_MISMATCH',
          'Reused output differs from its exact committed content.',
        );
        return;
      }
      const init: RequestInit & { duplex: 'half' } = {
        method: 'PUT',
        body: Readable.from(bytes) as unknown as BodyInit,
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: target.headers,
      };
      const response = await request(target.url, init);
      invariant(
        response.ok || response.status === 412,
        'SOURCE_WORKER_UNAVAILABLE',
        'Source upload was not acknowledged.',
      );
      await control('commit', { pin, input: config.input, executionId: config.executionId });
    },
  };
  return {
    transport,
  };
}
