// SPDX-License-Identifier: Apache-2.0
import { v, type ObjectType } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import {
  capsuleRunArgs,
  capsuleFinishKinds,
  capsulePageBytes,
  type CapsuleScope,
} from './projectLandingCapsuleCapture';
import { capsulePageRows } from './projectLandingCapsuleRemove';
import { capsuleRefsPage } from './projectLandingCapsuleRefs';
import { getLandingCapsule, putLandingCapsule } from './projectLandingCapsuleObject';
import { encodeLandingCapsule } from './projectLandingCapsuleCodec';
import type { LandingCapsule } from '../src/landing-capsule';
import { LANDING_CAPSULE_TABLES, type LandingCapsulePointer } from '../src/hosted-landing';
import { LANDINGS_ATTEMPTS, LANDINGS_REASON_CHARS } from '../src/hosted-landings-view';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
const begin = 'projectLandingCapsuleCapture:begin';
const runName = 'projectLandingCapsuleRun:pack';
const nodeRunName = 'projectLandingCapsuleRunNode:pack';
/** The V8 packer (64 MB isolate) holds several copies of the captured history: an isolated probe
 * grew 69 MB at 1.97 MiB raw (b149b16b), so landings over 1 MiB pack in Node. Dogfood's largest is
 * about 104 KB. */
export const capsuleV8RawBytes = 1024 * 1024;
type Part = { table: string; row: string };
const utf8 = (text: string) => new TextEncoder().encode(text).length;
function chunk(rows: Part[], offset: number) {
  const selected: Part[] = [];
  let bytes = 0;
  for (const row of rows.slice(offset, offset + capsulePageRows)) {
    const size = utf8(JSON.stringify(row));
    if (selected.length && bytes + size > capsulePageBytes) break;
    selected.push(row);
    bytes += size;
  }
  return selected;
}
function flatten(capsule: LandingCapsule) {
  return LANDING_CAPSULE_TABLES.flatMap(table => (capsule.tables[table] ?? []).map(row => ({ table, row })));
}
function evidence(rows: string[]) {
  const all = rows.map(text => JSON.parse(text)).sort((a, b) => a.number - b.number);
  const selected = all.slice(0, LANDINGS_ATTEMPTS);
  return {
    lastNumber: all.at(-1)?.number ?? null,
    bytes: selected.reduce((n, row) => n + row.value.length + (row.progress?.length ?? 0), 0),
    chain: selected.map(row => {
      const attempt = JSON.parse(row.value),
        progress = row.progress ? JSON.parse(row.progress) : null;
      return {
        number: row.number,
        value: canonicalPayload({
          number: attempt.number,
          candidate: { id: attempt.candidate.id },
          main: attempt.main,
          check: attempt.check ? { runId: attempt.check.runId } : null,
        }),
        ...(progress
          ? {
              progress: canonicalPayload({
                timing: progress.timing,
                error: progress.error
                  ? { ...progress.error, message: progress.error.message.slice(0, LANDINGS_REASON_CHARS) }
                  : null,
              }),
            }
          : {}),
      };
    }),
  };
}
type Runtime = 'v8' | 'node';
const rss = () =>
  (globalThis as { process?: { memoryUsage?: () => { rss: number } } }).process?.memoryUsage?.().rss ?? null;
/** One complete object, with canonical capture/removal bounded by page. There are no idle wakes.
 * Small scopes capture in batched transactions; publish removes up to 64 rows (128 KB) itself. */
export async function packLandingCapsule(
  ctx: Pick<ActionCtx, 'runMutation' | 'scheduler'>,
  input: ObjectType<typeof capsuleRunArgs>,
  runtime: Runtime,
) {
  if (process.env.FORGE_LANDING_CAPSULES !== '1') return canonicalPayload({ kept: true, reason: 'disabled' });
  const identity = { projectId: input.projectId, submissionId: input.submissionId };
  const started = Date.now();
  let calls = 0,
    maxPageMs = 0,
    sampledRss = rss();
  const sample = () => {
    const now = rss();
    if (now !== null) sampledRss = Math.max(sampledRss ?? 0, now);
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const at = Date.now();
    calls++;
    const value = await ctx.runMutation(makeFunctionReference<'mutation'>(name), args);
    maxPageMs = Math.max(maxPageMs, Date.now() - at);
    sample();
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  const toNode = async () => {
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>(nodeRunName), input);
    return canonicalPayload({ continuing: 'node' });
  };
  const finish = async (capsule: LandingCapsule, published: LandingCapsulePointer) => {
    let pointer = published;
    const rows = flatten(capsule);
    while (!JSON.parse(pointer.summary!).removalDone) {
      const offset = (pointer as LandingCapsulePointer & { removalOffset?: number }).removalOffset ?? 0;
      pointer = await invoke('projectLandingCapsuleRemove:page', {
        ...identity,
        sha256: pointer.sha256,
        offset,
        rows: chunk(rows, offset),
      });
    }
    const metrics = {
      runtime,
      calls,
      rows: rows.length,
      compressedBytes: pointer.size,
      rawBytes: pointer.rawSize,
      wallMs: Date.now() - started,
      maxPageMs,
      ...(sampledRss === null ? {} : { sampledRss }),
    };
    console.log(`FORGE_LANDING_CAPSULE ${JSON.stringify({ projectId: input.projectId, ...metrics })}`);
    return canonicalPayload({ pointer, metrics });
  };
  let selection = await invoke(begin, input);
  if (selection.kept || selection.deferred) return canonicalPayload(selection);
  let pointer = selection.pointer as LandingCapsulePointer | undefined;
  let capsule: LandingCapsule;
  if (!pointer && !selection.indexed) {
    let indexed = false;
    for (let page = 0; page < 20 && !indexed; page++)
      indexed = await invoke('projectLandingCapsuleIndex:page', { projectId: input.projectId });
    if (!indexed) {
      await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>(runName), input);
      return canonicalPayload({ continuing: 'index' });
    }
    selection = await invoke(begin, input);
    if (selection.kept || selection.deferred) return canonicalPayload(selection);
    pointer = selection.pointer;
  }
  if (pointer) {
    if (JSON.parse(pointer.summary!).removalDone) return canonicalPayload({ pointer, replayed: true });
    if (runtime === 'v8' && pointer.rawSize > capsuleV8RawBytes) return await toNode();
    const stored = await getLandingCapsule(input.projectId, input.submissionId, pointer);
    invariant(stored, 'SOURCE_UNAVAILABLE', 'Original capsule bytes are unavailable.');
    capsule = stored;
  } else {
    const tables: LandingCapsule['tables'] = {};
    const identities = new Map<string, Map<string, string>>();
    let rawBytes = 0;
    const add = (table: CapsuleScope['table'], rows: string[]) => {
      if (!identities.has(table)) identities.set(table, new Map());
      for (const text of rows) {
        const row = JSON.parse(text),
          old = identities.get(table)!.get(row._id);
        invariant(
          old === undefined || old === text,
          'WORK_STALE',
          'Captured row bytes changed between pages.',
        );
        if (old === undefined) rawBytes += utf8(text);
        identities.get(table)!.set(row._id, text);
      }
      tables[table] = [...identities.get(table)!.values()];
    };
    const tooLarge = () => runtime === 'v8' && rawBytes > capsuleV8RawBytes;
    const capture = async (scope: CapsuleScope) => {
      let cursor: string | null = null;
      do {
        const page = await invoke('projectLandingCapsuleCapture:page', {
          ...identity,
          version: selection.anchor.version,
          scope: canonicalPayload(scope),
          cursor,
        });
        if (page.pointer) {
          pointer = page.pointer;
          return;
        }
        add(scope.table, page.rows);
        cursor = page.cursor;
      } while (cursor !== null && !tooLarge());
    };
    /** Batched capture answers a prefix of the scopes; an oversized scope pages alone. */
    const captureAll = async (scopes: CapsuleScope[]) => {
      let pending = [...new Map(scopes.map(scope => [canonicalPayload(scope), scope])).values()];
      while (pending.length && !pointer && !tooLarge()) {
        const batch = pending.slice(0, 64);
        const result = await invoke('projectLandingCapsuleCapture:pages', {
          ...identity,
          version: selection.anchor.version,
          scopes: canonicalPayload(batch),
        });
        if (result.pointer) {
          pointer = result.pointer;
          return;
        }
        for (const [index, answer] of (result.results as Array<{ done: boolean; rows?: string[] }>).entries())
          if (answer.done) add(batch[index]!.table, answer.rows!);
          else await capture(batch[index]!);
        pending = pending.slice(result.results.length);
      }
    };
    await captureAll([
      { table: 'projectHostedLandingAttempts' },
      { table: 'projectHostedLandingObservations' },
      ...capsuleFinishKinds.map(kind => ({ table: 'projectFinishReadRows' as const, kind })),
    ]);
    if (tooLarge()) return await toNode();
    if (pointer) {
      const stored = await getLandingCapsule(input.projectId, input.submissionId, pointer);
      invariant(stored, 'SOURCE_UNAVAILABLE', 'Original capsule bytes are unavailable.');
      capsule = stored;
      return await finish(capsule, pointer);
    }
    const attempts = (tables.projectHostedLandingAttempts ?? []).map(text =>
      JSON.parse(JSON.parse(text).value),
    );
    const refs = [
      ...new Map(
        attempts
          .flatMap(attempt => [
            ...(attempt.check ? [{ kind: 'check', id: attempt.check.runId }] : []),
            { kind: 'compose', id: attempt.candidate.id },
            ...(attempt.memberCandidate ? [{ kind: 'compose', id: attempt.memberCandidate.id }] : []),
          ])
          .map(ref => [`${ref.kind}:${ref.id}`, ref]),
      ).values(),
    ];
    if (selection.request.admission?.runId && !refs.some(ref => ref.id === selection.request.admission.runId))
      refs.push({ kind: 'check', id: selection.request.admission.runId });
    const selectedRefs = [];
    for (let offset = 0; offset < refs.length; offset += capsuleRefsPage) {
      const result = await invoke('projectLandingCapsuleRefs:page', {
        ...input,
        refs: refs.slice(offset, offset + capsuleRefsPage),
      });
      if (result.deferred) return canonicalPayload(result);
      selectedRefs.push(...result.refs);
    }
    const scopes: CapsuleScope[] = [
      ...attempts.flatMap(attempt => [
        { table: 'projectHostedAcceptancePlans' as const, key: attempt.operations.accept },
        ...['inputs', 'dependencies'].map(kind => ({
          table: 'projectHostedAcceptancePages' as const,
          key: attempt.operations.accept,
          kind,
        })),
      ]),
    ];
    if (selection.receipt) {
      const receipt = JSON.parse(selection.receipt.value);
      scopes.push(
        { table: 'projectHostedAcceptanceEvents', sequence: selection.receipt.sequence },
        { table: 'projectHostedAcceptanceSnapshots', key: receipt.snapshot.id },
      );
    }
    for (const ref of selectedRefs) {
      if (ref.kind === 'check') {
        // Resume the original expiry operation, including cached pages after a lost scheduler wake.
        let request = ref.expiry;
        for (;;) {
          const outcome = await invoke('projectOperationalExpiry:check', request);
          invariant(!outcome.kept, 'SOURCE_UNAVAILABLE', 'Original callback expiry is not complete.');
          if (!outcome.more) break;
          request = { ...request, part: (request.part ?? 0) + 1, cursor: outcome.nextCursor };
        }
        scopes.push({ table: 'projectHostedCheckCallbacks', key: ref.id });
        for (const kind of ['callbacks', 'detail'])
          scopes.push({
            table: 'legacyStorageCleanupPages',
            key: `exhaust:${ref.id}:${kind}`,
            owner: `check:${ref.id}`,
          } as CapsuleScope);
      } else {
        scopes.push({ table: 'projectHostedComposePages', actor: ref.actor, key: ref.operationId });
        scopes.push({
          table: 'legacyStorageCleanupPages',
          key: `exhaust:${ref.jobId}:source`,
          owner: `compose:${ref.actor}:${ref.operationId}`,
        } as CapsuleScope);
      }
    }
    await captureAll(scopes);
    if (tooLarge()) return await toNode();
    if (pointer) {
      const stored = await getLandingCapsule(input.projectId, input.submissionId, pointer);
      invariant(stored, 'SOURCE_UNAVAILABLE', 'Original capsule bytes are unavailable.');
      capsule = stored;
    } else {
      capsule = {
        protocol: 1,
        projectId: input.projectId,
        submissionId: input.submissionId,
        anchor: selection.anchor,
        tables,
      };
      const encoded = encodeLandingCapsule(capsule);
      invariant(
        encoded.pointer.size <=
          Object.values(tables)
            .flat()
            .reduce((n, text) => n + utf8(text!), 0) +
            2 * 1024 * 1024,
        'EVIDENCE_CHANGED',
        'Capsule egress exceeded relocated bytes plus its fixed document header.',
      );
      await putLandingCapsule(input.projectId, input.submissionId, encoded, capsule);
      sample();
      const rows = flatten(capsule);
      pointer = await invoke('projectLandingCapsulePublish:publish', {
        ...identity,
        version: capsule.anchor.version,
        pointer: encoded.pointer,
        anchorHash: digest(canonicalPayload(capsule.anchor)),
        rows: chunk(rows, 0),
        summary: canonicalPayload({ evidence: evidence(tables.projectHostedLandingAttempts ?? []) }),
      });
      if (pointer!.sha256 !== encoded.pointer.sha256) {
        // Another run published first: remove against the copy its pointer names, never this run's.
        const stored = await getLandingCapsule(input.projectId, input.submissionId, pointer!);
        invariant(stored, 'SOURCE_UNAVAILABLE', 'Original capsule bytes are unavailable.');
        capsule = stored;
      }
    }
  }
  return await finish(capsule, pointer!);
}

export const pack = internalAction({
  args: capsuleRunArgs,
  returns: v.string(),
  handler: (ctx, input) => packLandingCapsule(ctx, input, 'v8'),
});
