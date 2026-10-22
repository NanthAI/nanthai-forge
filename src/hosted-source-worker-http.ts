// SPDX-License-Identifier: Apache-2.0
import { Readable } from 'node:stream';
import { z } from 'zod';
import { readSourceControlReply } from './hosted-source-control-reply.js';
import { invariant } from './errors.js';
import type { SourceDispatch, SourceJobCallback } from './hosted-source-job.js';
import type { WorkerPin } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';

const grant = z.object({ url: z.url(), headers: z.record(z.string(), z.string()).default({}) }).strict();
/** Fixed trusted ingress authorizes each pin using current job authority, then
 * returns exact R2 transfer URLs. It never proxies source bytes through Convex.
 * The grant/callback ingress is provisioned with the source-operation reducers. */
export function sourceWorkerHttp(config: {
  endpoint: string;
  token: string;
  executionId: string;
  input: SourceDispatch;
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
    const url = new URL(value.url);
    invariant(
      url.protocol === 'https:' && !url.username && !url.password && !url.hash,
      'SOURCE_WORKER_UNAVAILABLE',
      'Source transfer grant must use HTTPS.',
    );
    return { url, headers: value.headers };
  };
  const transport: SourceWorkerTransport = {
    async read(pin) {
      const target = await transfer('read', pin);
      const response = await request(target.url, {
        headers: target.headers,
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      invariant(response.ok && response.body, 'SOURCE_WORKER_UNAVAILABLE', 'Source transfer is unavailable.');
      return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    },
    async upload(pin, bytes) {
      const target = await transfer('upload', pin);
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
    callback: async (body: SourceJobCallback, signature: string) => {
      await control('callback', { callback: body, signature });
    },
  };
}
