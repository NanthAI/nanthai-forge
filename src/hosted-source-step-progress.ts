// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from 'node:zlib';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { parseSourceCursor } from './hosted-source-cursor-schema.js';
import type { SourceStepCursor } from './hosted-source-step.js';
import { inflateSourceMetadata } from './hosted-source-task-data.js';
const fields = [
  'files',
  'inventory',
  'queue',
  'seen',
  'parents',
  'ancestryFailures',
  'selections',
  'calculations',
  'composeBases',
] as const;
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
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ForgeError('SOURCE_HASH_MISMATCH', 'Durable source progress changed.');
  }
  invariant(
    value &&
      value.kind === 'forge-source-progress-v1' &&
      value.cursor &&
      typeof value.cursor === 'object' &&
      !Array.isArray(value.cursor) &&
      value.sections &&
      typeof value.sections === 'object' &&
      !Array.isArray(value.sections) &&
      Object.keys(value).every(key => ['kind', 'cursor', 'sections'].includes(key)) &&
      Object.keys(value.sections).every(key => (fields as readonly string[]).includes(key)),
    'SOURCE_JOB_INVALID',
    'Source progress encoding changed.',
  );
  const cursor = { ...value.cursor };
  for (const field of fields) {
    const section = value.sections[field];
    if (section === undefined) continue;
    invariant(
      !!section &&
        typeof section === 'object' &&
        !Array.isArray(section) &&
        typeof section.id === 'string' &&
        section.id.length > 0 &&
        Object.keys(section).every(key => ['id', 'sha256'].includes(key)) &&
        typeof section.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(section.sha256),
      'SOURCE_JOB_INVALID',
      'Source progress section encoding changed.',
    );
    const compressed = await read(section.id);
    const bytes = inflateSourceMetadata(compressed);
    invariant(digest(bytes) === section.sha256, 'SOURCE_HASH_MISMATCH', 'Durable source metadata changed.');
    try {
      Object.assign(cursor, { [field]: JSON.parse(bytes.toString('utf8')) });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ForgeError('SOURCE_HASH_MISMATCH', 'Durable source metadata encoding changed.');
    }
  }
  return { cursor: parseSourceCursor(cursor), value };
}
