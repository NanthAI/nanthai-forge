// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { capsuleRunArgs, capsuleFinishKinds, type CapsuleScope } from './projectLandingCapsuleCapture';
import { getLandingCapsule, putLandingCapsule } from './projectLandingCapsuleObject';
import { encodeLandingCapsule } from '../src/landing-capsule-bytes';
import type { LandingCapsule } from '../src/landing-capsule';
import { LANDING_CAPSULE_TABLES, type LandingCapsulePointer } from '../src/hosted-landing';
import { LANDINGS_ATTEMPTS, LANDINGS_REASON_CHARS } from '../src/hosted-landings-view';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
const begin = 'projectLandingCapsuleCapture:begin';
const runName = 'projectLandingCapsuleRun:pack';
type Part = { table: string; row: string };
function chunk(rows: Part[], offset: number) {
  const selected: Part[] = [];
  let bytes = 0;
  for (const row of rows.slice(offset, offset + 8)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (selected.length && bytes + size > 128 * 1024) break;
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
/** One complete object, with canonical capture/removal bounded by page. There are no idle wakes. */
export const pack = internalAction({
  args: capsuleRunArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    if (process.env.FORGE_LANDING_CAPSULES !== '1')
      return canonicalPayload({ kept: true, reason: 'disabled' });
    const identity = { projectId: input.projectId, submissionId: input.submissionId };
    const started = performance.now();
    let calls = 0,
      maxPageMs = 0,
      sampledRss = process.memoryUsage().rss;
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const at = performance.now();
      calls++;
      const value = await ctx.runMutation(makeFunctionReference<'mutation'>(name), args);
      maxPageMs = Math.max(maxPageMs, performance.now() - at);
      sampledRss = Math.max(sampledRss, process.memoryUsage().rss);
      return typeof value === 'string' ? JSON.parse(value) : value;
    };
    let selection = await invoke(begin, input);
    if (selection.kept || selection.deferred) return canonicalPayload(selection);
    let pointer = selection.pointer as LandingCapsulePointer | undefined;
    let capsule: LandingCapsule;
    if (!pointer) {
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
      const stored = await getLandingCapsule(input.projectId, input.submissionId, pointer);
      invariant(stored, 'SOURCE_UNAVAILABLE', 'Original capsule bytes are unavailable.');
      capsule = stored;
    } else {
      const tables: LandingCapsule['tables'] = {};
      const identities = new Map<string, Map<string, string>>();
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
          identities.get(table)!.set(row._id, text);
        }
        tables[table] = [...identities.get(table)!.values()];
      };
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
        } while (cursor !== null);
      };
      await capture({ table: 'projectHostedLandingAttempts' });
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
      if (
        selection.request.admission?.runId &&
        !refs.some(ref => ref.id === selection.request.admission.runId)
      )
        refs.push({ kind: 'check', id: selection.request.admission.runId });
      const selectedRefs = [];
      for (let offset = 0; offset < refs.length; offset += 4) {
        const result = await invoke('projectLandingCapsuleRefs:page', {
          ...input,
          refs: refs.slice(offset, offset + 4),
        });
        if (result.deferred) return canonicalPayload(result);
        selectedRefs.push(...result.refs);
      }
      const scopes: CapsuleScope[] = [
        { table: 'projectHostedLandingObservations' },
        ...capsuleFinishKinds.map(kind => ({ table: 'projectFinishReadRows' as const, kind })),
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
      for (const scope of new Map(scopes.map(scope => [canonicalPayload(scope), scope])).values()) {
        if (pointer) break;
        await capture(scope);
      }
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
              .reduce((n, text) => n + Buffer.byteLength(text!), 0) +
              2 * 1024 * 1024,
          'EVIDENCE_CHANGED',
          'Capsule egress exceeded relocated bytes plus its fixed document header.',
        );
        await putLandingCapsule(input.projectId, input.submissionId, encoded, capsule);
        sampledRss = Math.max(sampledRss, process.memoryUsage().rss);
        const rows = flatten(capsule);
        pointer = await invoke('projectLandingCapsulePublish:publish', {
          ...identity,
          version: capsule.anchor.version,
          pointer: encoded.pointer,
          anchorHash: digest(canonicalPayload(capsule.anchor)),
          rows: chunk(rows, 0),
          summary: canonicalPayload({ evidence: evidence(tables.projectHostedLandingAttempts ?? []) }),
        });
      }
    }
    const rows = flatten(capsule);
    while (!JSON.parse(pointer!.summary!).removalDone) {
      const offset = (pointer as LandingCapsulePointer & { removalOffset?: number }).removalOffset ?? 0;
      pointer = await invoke('projectLandingCapsuleRemove:page', {
        ...identity,
        sha256: pointer!.sha256,
        offset,
        rows: chunk(rows, offset),
      });
    }
    const metrics = {
      calls,
      rows: rows.length,
      compressedBytes: pointer!.size,
      rawBytes: pointer!.rawSize,
      wallMs: performance.now() - started,
      maxPageMs,
      sampledRss,
    };
    console.log(`FORGE_LANDING_CAPSULE ${JSON.stringify({ projectId: input.projectId, ...metrics })}`);
    return canonicalPayload({ pointer, metrics });
  },
});
