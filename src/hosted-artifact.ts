// SPDX-License-Identifier: Apache-2.0
import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { ForgeError, invariant } from './errors.js';
import type { HostedArtifact } from './github.js';
import { graphJsonParts } from './hash.js';
import type { GraphPack } from './types.js';

const maxBytes = 128 * 1024 * 1024;

export async function encodeHostedArtifact(artifact: HostedArtifact): Promise<Blob> {
  let expanded = 0,
    stored = 0;
  function* parts(): Generator<string> {
    yield '{';
    let separator = '';
    for (const [key, value] of Object.entries(artifact)) {
      yield `${separator}${JSON.stringify(key)}:`;
      const values = key === 'pack' ? graphJsonParts(value as GraphPack) : [JSON.stringify(value)];
      yield* values;
      separator = ',';
    }
    yield '}';
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const input = Readable.from(parts()).map((part: string) => {
    expanded += Buffer.byteLength(part);
    invariant(expanded <= maxBytes, 'ARTIFACT_LIMIT', 'Source and graph exceed the 128 MiB artifact budget.');
    return part;
  });
  for await (const chunk of input.compose(createGzip())) {
    stored += chunk.length;
    invariant(
      stored <= maxBytes,
      'ARTIFACT_LIMIT',
      'Stored source and graph exceed the 128 MiB artifact budget.',
    );
    chunks.push(new Uint8Array(chunk));
  }
  return new Blob(chunks, { type: 'application/gzip' });
}

export async function decodeHostedArtifact(blob: Blob): Promise<HostedArtifact> {
  invariant(blob.size <= maxBytes, 'INVALID_ARTIFACT', 'Stored source exceeds its artifact budget.');
  try {
    let json = '';
    if (blob.type === 'application/gzip') {
      const stream = Readable.from([Buffer.from(await blob.arrayBuffer())]).pipe(createGunzip());
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        invariant(bytes <= maxBytes, 'INVALID_ARTIFACT', 'Stored source exceeds its artifact budget.');
        json += decoder.decode(chunk, { stream: true });
      }
      json += decoder.decode();
    } else json = await blob.text();
    return JSON.parse(json) as HostedArtifact;
  } catch {
    throw new ForgeError('INVALID_ARTIFACT', 'Stored source is corrupt or exceeds its artifact budget.');
  }
}
