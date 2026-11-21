// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { internalAction, internalMutation, internalQuery, type QueryCtx } from './server';
import { retirementPin } from './legacyStorageCleanupFields';
import { checkLegacyFile } from './legacyStoragePinGuard';
import { cleanupReceipt, recordCleanup } from './legacyStorageReceipts';
import { lookupLegacyCopy, verifyLegacyCopy } from './legacyStorageRead';
import { findObjects } from './projectObjectFind';
import { r2Config, r2Key } from './r2';
import { digest } from '../src/state/hash';
import { mapExchange } from '../src/exchange-parallel';
import { invariant } from '../src/errors';

const scope = v.object({
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  pins: v.array(retirementPin),
});
const result = v.object({
  retired: v.number(),
  bytes: v.number(),
  changedRows: v.number(),
  retainedCopies: v.number(),
  retiredAt: v.number(),
});
type Scope = Infer<typeof scope>;
type Receipt = Infer<typeof result>;
const part = 'online-retirement';
const requestDigest = ({ projectId, pins }: Scope) =>
  digest(
    JSON.stringify([
      projectId,
      pins.map(pin => [
        pin.storageId,
        pin.digest,
        pin.size,
        pin.class,
        pin.copyKey,
        pin.owners.map(owner => [owner.table, owner.id]),
      ]),
    ]),
  );
const approvedDev = 'https://benevolent-wildebeest-974.convex.cloud';
function requireApprovedDev() {
  invariant(
    process.env.CONVEX_CLOUD_URL === approvedDev,
    'PROJECT_UNAVAILABLE',
    'This retirement tool is scoped to the approved Forge dev deployment.',
  );
}

// Bind the internal commit to the verifying action without a second DB write
// or a new deployment secret. The proof never leaves those two functions.
const encoder = new TextEncoder();
const proofInput = (operationId: string, request: string, verifiedAt: number, bindings: string) =>
  encoder.encode(JSON.stringify([part, approvedDev, operationId, request, verifiedAt, bindings]));
const proofKey = (usage: 'sign' | 'verify') =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(r2Config().secretAccessKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );

function uniqueCopies(pins: Scope['pins']) {
  return [...new Map(pins.map(pin => [pin.copyKey, pin])).values()];
}

async function checkPage(ctx: QueryCtx, input: Scope, verifiedAt: number) {
  const { projectId, operationId, pins } = input;
  invariant(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(operationId) &&
      pins.length > 0 &&
      pins.length <= 100 &&
      new Set(pins.map(pin => pin.storageId)).size === pins.length &&
      pins.every(
        pin =>
          /^[a-f0-9]{64}$/.test(pin.digest) &&
          Number.isSafeInteger(pin.size) &&
          pin.size >= 0 &&
          pin.copyKey === r2Key(projectId, pin.digest) &&
          pin.owners.length <= 2 &&
          new Set(pin.owners.map(owner => owner.id)).size === pin.owners.length,
      ),
    'BAD_ARGUMENT',
    'Use a bounded retirement page with exact legacy and same-project R2 pins.',
  );
  const project = await ctx.db.get(projectId);
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an active project.');
  const copies = uniqueCopies(pins);
  const sizes = new Map(copies.map(copy => [copy.copyKey, copy.size]));
  invariant(
    pins.every(pin => sizes.get(pin.copyKey) === pin.size),
    'BAD_ARGUMENT',
    'The same R2 copy cannot have different pinned sizes.',
  );
  const objects = await findObjects(
    ctx,
    projectId,
    copies.map(copy => copy.digest),
  );
  const bindings = [];
  for (const [index, copy] of copies.entries()) {
    const row = objects[index];
    invariant(
      row?.r2SweepKey !== copy.copyKey,
      'EVIDENCE_CHANGED',
      'The retained R2 key has a delete claim.',
    );
    bindings.push(row ? [row._id ?? null, row.nonce, row.r2Key ?? null] : null);
  }
  const checked = [];
  for (const pin of pins) {
    const existing = await lookupLegacyCopy(ctx, pin.storageId);
    const { code, file, owners } = await checkLegacyFile(
      ctx,
      { ...pin, keys: [pin.copyKey] },
      { verifiedAt },
    );
    invariant(
      !existing && !code && file,
      'EVIDENCE_CHANGED',
      `Legacy file ${pin.storageId} cannot be retired (${code ?? 'TOMBSTONE_PRESENT'}).`,
    );
    checked.push({ pin, contentType: file.contentType, owners });
  }
  return { checked, copies, bindings: digest(JSON.stringify(bindings)) };
}

const prepared = v.union(v.object({ receipt: result }), v.object({ bindings: v.string() }));
export const prepare = internalQuery({
  args: scope.fields,
  returns: prepared,
  handler: async (ctx, input): Promise<Infer<typeof prepared>> => {
    requireApprovedDev();
    const receipt = await cleanupReceipt(ctx, input.operationId, part, requestDigest(input));
    if (receipt) return { receipt };
    return { bindings: (await checkPage(ctx, input, Date.now())).bindings };
  },
});

/** Only the deployment operator action calls this after full-body verification.
 * The file, tombstone and retry receipt switch together in one transaction. */
export const commit = internalMutation({
  args: { ...scope.fields, verifiedAt: v.number(), bindings: v.string(), proof: v.string() },
  returns: result,
  handler: async (ctx, { verifiedAt, bindings, proof, ...input }): Promise<Receipt> => {
    requireApprovedDev();
    const request = requestDigest(input),
      old = await cleanupReceipt(ctx, input.operationId, part, request);
    if (old) return old;
    invariant(
      /^[a-f0-9]{64}$/.test(proof) &&
        (await crypto.subtle.verify(
          'HMAC',
          await proofKey('verify'),
          new Uint8Array(hexToBytes(proof)),
          proofInput(input.operationId, request, verifiedAt, bindings),
        )),
      'R2_VERIFIED_PASS_REQUIRED',
      'Verify the full retained R2 copies through the retirement action before switching.',
    );
    const page = await checkPage(ctx, input, verifiedAt);
    invariant(
      page.bindings === bindings,
      'EVIDENCE_CHANGED',
      'The R2 object binding changed during copy verification. Recheck the original page.',
    );
    const { copies, checked } = page;
    const receipt = {
      retired: 0,
      bytes: 0,
      changedRows: 0,
      retainedCopies: copies.length,
      retiredAt: Date.now(),
    };
    for (const { pin, contentType, owners } of checked) {
      const { storageId, digest, size, copyKey } = pin;
      await ctx.db.insert('legacyStorageTombstones', {
        storageId,
        digest,
        size,
        copyKey,
        operationId: input.operationId,
        ...(contentType === undefined ? {} : { contentType }),
      });
      await ctx.storage.delete(storageId);
      for (const row of owners) {
        await ctx.db.patch(row._id, { r2ConvexPurged: true });
        receipt.changedRows++;
      }
      receipt.retired++;
      receipt.bytes += size;
    }
    await recordCleanup(ctx, input.operationId, part, request, receipt);
    return receipt;
  },
});

/** Rehearse without writes, or verify and retire an exact page. Uses only
 * existing R2 copies. A replay returns the original receipt before any GET. */
export const run = internalAction({
  args: { ...scope.fields, apply: v.boolean() },
  returns: v.object({ verifiedCopies: v.number(), receipt: v.union(result, v.null()) }),
  handler: async (ctx, { apply, ...input }) => {
    requireApprovedDev();
    const prior: Infer<typeof prepared> = await ctx.runQuery(
      makeFunctionReference<'query'>('projectLegacyStorageRetirement:prepare'),
      input,
    );
    if ('receipt' in prior) return { verifiedCopies: 0, receipt: prior.receipt };
    const copies = uniqueCopies(input.pins),
      verifiedAt = Date.now();
    await mapExchange(copies, 4, copy => verifyLegacyCopy(copy));
    if (!apply) return { verifiedCopies: copies.length, receipt: null };
    const proof = await crypto.subtle.sign(
      'HMAC',
      await proofKey('sign'),
      proofInput(input.operationId, requestDigest(input), verifiedAt, prior.bindings),
    );
    const receipt: Receipt = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectLegacyStorageRetirement:commit'),
      { ...input, verifiedAt, bindings: prior.bindings, proof: bytesToHex(new Uint8Array(proof)) },
    );
    return { verifiedCopies: copies.length, receipt };
  },
});

/** Confirm every retired pin is readable through the same tombstone index. */
export const observe = internalQuery({
  args: scope.fields,
  returns: v.object({ receipt: result, matchingTombstones: v.number() }),
  handler: async (ctx, input) => {
    requireApprovedDev();
    const receipt: Receipt | null = await cleanupReceipt(ctx, input.operationId, part, requestDigest(input));
    invariant(receipt, 'NOT_FOUND', 'No committed receipt exists for this retirement page.');
    let matchingTombstones = 0;
    for (const pin of input.pins) {
      const copy = await lookupLegacyCopy(ctx, pin.storageId);
      invariant(
        copy &&
          copy.operationId === input.operationId &&
          copy.digest === pin.digest &&
          copy.size === pin.size &&
          copy.copyKey === pin.copyKey &&
          !(await ctx.db.system.get(pin.storageId)),
        'EVIDENCE_CHANGED',
        'A retired file no longer matches its fallback pin.',
      );
      matchingTombstones++;
    }
    return { receipt, matchingTombstones };
  },
});
