// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { projectBackupPreview } from './schema';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
export const backupTransferArgs = {
  key: v.string(),
  name: v.string(),
  operationId: v.string(),
  previous: v.union(v.id('projectBackups'), v.null()),
  digest: v.string(),
  size: v.number(),
  preview: projectBackupPreview,
};
type Input = {
  key: string;
  name: string;
  operationId: string;
  previous: Id<'projectBackups'> | null;
  digest: string;
  size: number;
  preview: Doc<'projectBackups'>['preview'];
};
export function backupTransferRequest(input: Input) {
  const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  invariant(
    uuid.test(input.key) &&
      uuid.test(input.operationId) &&
      input.name.trim() &&
      /^[0-9a-f]{64}$/.test(input.digest) &&
      Number.isSafeInteger(input.size) &&
      input.size > 0,
    'BAD_ARGUMENT',
    'Select a named project and exact Forge archive size/digest.',
  );
  invariant(
    /^[0-9a-f]{64}$/.test(input.preview.manifestDigest) &&
      input.preview.head.length === (input.preview.format === 'sha1' ? 40 : 64) &&
      /^[0-9a-f]+$/.test(input.preview.head) &&
      [
        input.preview.revision,
        input.preview.intents,
        input.preview.lanes,
        input.preview.views,
        input.preview.runs,
        input.preview.files,
        input.preview.unavailable,
      ].every(value => Number.isSafeInteger(value) && value >= 0) &&
      input.preview.channels.every(
        pin => pin.name && pin.head.length === input.preview.head.length && /^[0-9a-f]+$/.test(pin.head),
      ),
    'BAD_ARGUMENT',
    'Archive source and Work preview fields are invalid.',
  );
  const args = { ...input, name: input.name.trim() },
    p = input.preview;
  const request = digest(
    JSON.stringify([
      args.key,
      args.name,
      args.operationId,
      args.previous,
      args.digest,
      args.size,
      p.manifestDigest,
      p.head,
      p.format,
      p.revision,
      p.intents,
      p.lanes,
      p.views,
      p.runs,
      p.files,
      p.unavailable,
      p.channels.map(pin => [pin.name, pin.head]),
    ]),
  );
  return { args, request };
}
