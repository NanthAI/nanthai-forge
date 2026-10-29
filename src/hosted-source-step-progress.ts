// SPDX-License-Identifier: Apache-2.0
import { gzipSync, gunzipSync } from 'node:zlib';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import type { SourceStepCursor } from './hosted-source-step.js';
const fields = ['files', 'inventory', 'queue', 'seen', 'parents', 'selections', 'calculations'] as const;
type Section = { sha256: string; id: string };
export type SourceProgress = {
  kind: 'forge-source-progress-v1';
  cursor: Partial<SourceStepCursor>;
  sections: Partial<Record<(typeof fields)[number], Section>>;
};
/** Large immutable metadata is written once and reused by storage reference.
 * Queue advancement is an index, not a rewritten list of remaining objects. */
export async function saveSourceProgress(
  cursor: SourceStepCursor,
  previous: SourceProgress | null,
  store: (bytes: Uint8Array) => Promise<string>,
) {
  const value: SourceProgress = { kind: 'forge-source-progress-v1', cursor: { ...cursor }, sections: {} };
  for (const field of fields) {
    const bytes = Buffer.from(JSON.stringify(cursor[field] ?? {}));
    if (bytes.length <= 8192) continue;
    const sha256 = digest(bytes),
      prior = previous?.sections[field];
    value.sections[field] =
      prior?.sha256 === sha256 ? prior : { sha256, id: await store(gzipSync(bytes, { level: 1 })) };
    delete value.cursor[field];
  }
  return { id: await store(Buffer.from(JSON.stringify(value))), value };
}
export async function loadSourceProgress(bytes: Uint8Array, read: (id: string) => Promise<Uint8Array>) {
  let value: SourceProgress;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8')) as SourceProgress;
  } catch {
    throw new ForgeError('SOURCE_HASH_MISMATCH', 'Durable source progress changed.');
  }
  invariant(
    value.kind === 'forge-source-progress-v1',
    'SOURCE_JOB_INVALID',
    'Source progress encoding changed.',
  );
  const cursor = { ...value.cursor };
  for (const field of fields) {
    const section = value.sections[field];
    if (!section) continue;
    let bytes: Buffer;
    try {
      bytes = gunzipSync(await read(section.id));
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError('SOURCE_HASH_MISMATCH', 'Durable source metadata changed.');
    }
    invariant(digest(bytes) === section.sha256, 'SOURCE_HASH_MISMATCH', 'Durable source metadata changed.');
    Object.assign(cursor, { [field]: JSON.parse(bytes.toString('utf8')) });
  }
  return { cursor: cursor as SourceStepCursor, value };
}
