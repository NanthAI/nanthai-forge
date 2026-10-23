// SPDX-License-Identifier: Apache-2.0
import type { ConvexReactClient } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import { browserManifest, browserObjects, sourcePlan } from './browser-source';
import { verifiedBytes, sha256Hex } from './verified-blob';
import { downloadPinSchema } from '../../src/blob-download-format';
import { invariant } from '../../src/errors';
import { safeRelative } from '../../src/safe-relative';
import { z } from 'zod';
const encoder = new TextEncoder();
const recordsSchema = z.object({
  kind: z.literal('forge-work-records'),
  schema: z.literal(2),
  work: downloadPinSchema,
  fields: z.array(
    z.union([
      z.object({ name: z.string(), records: z.array(downloadPinSchema) }),
      z.object({ name: z.string(), value: z.unknown() }),
    ]),
  ),
});
function header(path: string, size: number) {
  invariant(safeRelative(path), 'INVALID_WORK_BACKUP', 'Archive contains an invalid path.');
  const block = new Uint8Array(512);
  const text = (at: number, length: number, value: string) => {
    const bytes = encoder.encode(value);
    invariant(bytes.length <= length, 'INVALID_WORK_BACKUP', 'Archive header field is too long.');
    block.set(bytes, at);
  };
  const octal = (at: number, length: number, n: number) =>
    text(at, length, n.toString(8).padStart(length - 1, '0') + '\0');
  if (encoder.encode(path).length > 100) {
    const split = path.lastIndexOf('/');
    text(0, 100, path.slice(split + 1));
    text(345, 155, path.slice(0, split));
  } else text(0, 100, path);
  octal(100, 8, 0o600);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  text(148, 8, '        ');
  text(156, 1, '0');
  text(257, 6, 'ustar\0');
  text(263, 2, '00');
  const sum = block.reduce((sum, byte) => sum + byte, 0);
  text(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return block;
}
/** New gzip container of exact manifest/member bytes. Its digest is distinct from the
 * original exchange receipt; it does not replace a matching source/Work journal pair. */
export async function downloadObjectArchive(
  client: Pick<ConvexReactClient, 'mutation'>,
  projectId: Id<'hostedProjects'>,
  backupId: Id<'projectBackups'>,
  progress?: (received: number, total: number) => void,
) {
  const plan = await sourcePlan(client, { projectId, backupId });
  invariant(plan.transport === 'objects', 'BAD_ARGUMENT', 'Select an object-backed checkpoint.');
  const reader = browserObjects(client, projectId),
    { manifest, manifestBytes, exchange } = await browserManifest(client, projectId, plan);
  const workPin = manifest.files.find(file => file.path === 'work.json');
  invariant(workPin, 'INVALID_WORK_BACKUP', 'Archive omits Work.');
  let work: Uint8Array | undefined;
  if (exchange?.schema === 1) {
    invariant(exchange.work.tree, 'INVALID_WORK_BACKUP', 'Archive omits its Work tree.');
    work = await reader.tree(exchange.work, exchange.work.tree);
  } else if (exchange?.schema === 2) {
    invariant(exchange.records, 'INVALID_WORK_BACKUP', 'Archive omits its Work records.');
    const root = recordsSchema.parse(
      JSON.parse(new TextDecoder().decode(await reader.tree(exchange.records, exchange.records.tree))),
    );
    invariant(
      root.work.sha256 === workPin.sha256 && root.work.size === workPin.size,
      'INVALID_WORK_BACKUP',
      'Archive Work differs from its record binding.',
    );
    const chunks: BlobPart[] = ['{'];
    for (const [index, field] of root.fields.entries()) {
      chunks.push(`${index ? ',' : ''}\n  ${JSON.stringify(field.name)}: `);
      if ('records' in field) {
        chunks.push('[');
        for (const [i, pin] of field.records.entries()) {
          const [bytes] = await reader.read([pin]);
          chunks.push(i ? ',\n' : '\n', new Uint8Array(bytes!).buffer);
        }
        chunks.push(field.records.length ? '\n  ]' : ']');
      } else chunks.push(JSON.stringify(field.value, null, 2).replaceAll('\n', '\n  '));
    }
    chunks.push(root.fields.length ? '\n}' : '}');
    work = new Uint8Array(await new Blob(chunks).arrayBuffer());
  }
  if (work) {
    invariant(work.length === workPin.size, 'BLOB_DIGEST_MISMATCH', 'Archive Work size differs.');
    await verifiedBytes(work, workPin.sha256);
  }
  const parts: BlobPart[] = [];
  const append = (path: string, bytes: Uint8Array) =>
    parts.push(
      header(path, bytes.length).buffer,
      new Uint8Array(bytes).buffer,
      new Uint8Array((512 - (bytes.length % 512)) % 512).buffer,
    );
  append('manifest.json', manifestBytes);
  let received = 0;
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  for (let at = 0; at < manifest.files.length; at += 100) {
    const batch = manifest.files.slice(at, at + 100);
    const values = await reader.read(batch.filter(pin => pin.path !== 'work.json' || !work));
    let index = 0;
    for (const pin of batch) {
      const bytes = pin.path === 'work.json' && work ? work : values[index++]!;
      append(pin.path, bytes);
      received += bytes.length;
      progress?.(received, total);
    }
  }
  parts.push(new Uint8Array(1024).buffer);
  const final = await sourcePlan(client, { projectId, backupId });
  invariant(
    final.backupDigest === plan.backupDigest && final.manifestDigest === plan.manifestDigest,
    'SOURCE_CHANGED',
    'The selected checkpoint changed while downloading.',
  );
  const blob = await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return {
    blob,
    filename: `forge-backup-${plan.operationId}.tar.gz`,
    digest: await sha256Hex(new Uint8Array(await blob.arrayBuffer())),
  };
}
