// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { openSecret, secretInputTag, type SecretKeyring } from './secret-crypto.js';
import { invariant } from './errors.js';

const sealed = z.object({ keyId: z.string(), nonce: z.string(), tag: z.string(), ciphertext: z.string() });
const archiveSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('forge-secret-object'),
  grantsAuthority: z.literal('historical-only'),
  complete: z.literal(true),
  object: z
    .object({
      _id: z.string(),
      owner: z.string(),
      operationId: z.string(),
      name: z.string(),
      repository: z.string(),
      ref: z.string(),
      version: z.number().int().positive(),
    })
    .passthrough(),
  pins: z.object({ version: z.number(), policyRevision: z.number(), archiveRevision: z.number() }),
  eventThrough: z.number().nullable(),
  eventThroughId: z.string().nullable(),
  versions: z.array(
    z
      .object({
        _id: z.string(),
        secretId: z.string(),
        version: z.number().int().positive(),
        previousVersion: z.number().int().nonnegative(),
        operationId: z.string(),
        inputTag: z.string(),
        sealed,
      })
      .passthrough(),
  ),
  grants: z.array(
    z
      .object({
        _id: z.string(),
        secretId: z.string(),
        principal: z.string(),
        capabilities: z.array(z.string()),
      })
      .passthrough(),
  ),
  events: z.array(
    z
      .object({
        _id: z.string(),
        _creationTime: z.number(),
        secretId: z.string(),
        actor: z.string(),
        operationId: z.string(),
        kind: z.string(),
      })
      .passthrough(),
  ),
});

/** Recover values offline with separately retained original keys. This installs no object, grants or authority. */
export function recoverSecretArchive(text: string, keys: SecretKeyring) {
  const parsed = archiveSchema.safeParse(JSON.parse(text));
  invariant(parsed.success, 'SECRET_INVALID', 'This is not a complete supported Secret Object archive.');
  const archive = parsed.data,
    object = archive.object;
  invariant(
    archive.pins.version === object.version && archive.versions.length === object.version,
    'SECRET_INVALID',
    'The archive does not retain all original Secret Object versions.',
  );
  const all = [...archive.versions, ...archive.grants, ...archive.events];
  invariant(
    all.every(row => row.secretId === object._id) && new Set(all.map(row => row._id)).size === all.length,
    'SECRET_INVALID',
    'The archive contains unrelated or duplicate records.',
  );
  invariant(
    archive.events.every(row => archive.eventThrough !== null && row._creationTime <= archive.eventThrough),
    'SECRET_INVALID',
    'Audit observations exceed the original export boundary.',
  );
  invariant(
    archive.eventThroughId === null
      ? archive.events.length === 0
      : archive.events.some(row => row._id === archive.eventThroughId),
    'SECRET_INVALID',
    'The original audit export boundary is missing.',
  );
  const versions = [...archive.versions]
    .sort((a, b) => a.version - b.version)
    .map((row, index) => {
      invariant(
        row.version === index + 1 && row.previousVersion === index,
        'SECRET_INVALID',
        'The original version ancestry is incomplete.',
      );
      const binding = {
        owner: object.owner,
        operationId: object.operationId,
        repository: object.repository,
        ref: object.ref,
        version: row.version,
      };
      const value = openSecret(keys, binding, row.sealed);
      invariant(
        secretInputTag(keys, binding, value, row.sealed.keyId) === row.inputTag,
        'SECRET_INVALID',
        'The original version input could not be verified.',
      );
      return { version: row.version, operationId: row.operationId, value };
    });
  return {
    object,
    versions,
    grants: archive.grants,
    events: archive.events,
    grantsAuthority: 'historical-only' as const,
  };
}
