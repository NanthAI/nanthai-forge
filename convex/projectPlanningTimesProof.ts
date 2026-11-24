// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize } from 'convex/values';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { ForgeError, invariant } from '../src/errors';
import { isShelved } from '../src/work-planning-types';
import { planningStatusTransition } from '../src/work-planning-state';
import { planningHistoryBudget, recordSnapshot } from './projectPlanningHistory';
import { planningTime, type PlanningTimes } from './projectPlanningTimes';

type HeadCursor = {
  key: string;
  recordId: Id<'projectHostedRecords'>;
  version: number;
  status: string;
  visitedVersion: number;
  changeVersion?: number;
};
const encoder = new TextEncoder();
const cursorBytes = (projectId: string, payload: string) =>
  encoder.encode(
    JSON.stringify(['forge-planning-times-cursor-v1', process.env.CONVEX_CLOUD_URL, projectId, payload]),
  );
function cursorKey(usage: 'sign' | 'verify') {
  // All hosted deployments already require R2. A domain-separated MAC adds neither a new
  // deployment setting nor a durable checkpoint that would need its own storage and cleanup.
  const key = process.env.R2_SECRET_ACCESS_KEY;
  invariant(key, 'R2_NOT_CONFIGURED', 'Resume the planning times proof on an R2-configured deployment.');
  return crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);
}
export async function sealPlanningHeadCursor(projectId: Id<'hostedProjects'>, cursor: HeadCursor) {
  const payload = JSON.stringify(cursor);
  const mac = await crypto.subtle.sign('HMAC', await cursorKey('sign'), cursorBytes(projectId, payload));
  return `${payload}.${bytesToHex(new Uint8Array(mac))}`;
}
export async function openPlanningHeadCursor(projectId: Id<'hostedProjects'>, token: string) {
  const separator = token.lastIndexOf('.');
  const payload = token.slice(0, separator);
  const mac = token.slice(separator + 1);
  invariant(
    token.length <= 1024 &&
      separator > 0 &&
      /^[a-f0-9]{64}$/.test(mac) &&
      (await crypto.subtle.verify(
        'HMAC',
        await cursorKey('verify'),
        new Uint8Array(hexToBytes(mac)),
        cursorBytes(projectId, payload),
      )),
    'BAD_ARGUMENT',
    'This planning head checkpoint is invalid. Resume from the last completed Item key without it.',
  );
  return JSON.parse(payload) as HeadCursor;
}

const scanBytes = 384 * 1024;
const snapshotBytes = 1024 * 1024;
type Head = Doc<'projectHostedRecordHeads'>;
type Record = Doc<'projectHostedRecords'>;
type Snapshot = { id: string; version: number; status: string; at?: string; was?: string; purged?: unknown };
type Result =
  | { times: PlanningTimes; readBytes: number }
  | { resume: HeadCursor; readBytes: number }
  | { blocked: true; readBytes: number };

/** Follow adjacent immutable status headers; load bodies only for timestamp/shelf evidence.
 * A checkpoint holds version numbers, not dates or body bytes. Never advance it past a gap. */
export async function provePlanningTimes(
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  head: Head,
  cursor?: HeadCursor,
): Promise<Result> {
  const scan = planningHistoryBudget(scanBytes);
  let evidenceBytes = 0;
  const readBytes = () => scan.readBytes + evidenceBytes;
  const blocked = (): Result => ({ blocked: true, readBytes: readBytes() });
  const exact = async (version: number) => {
    const row = await ctx.db
      .query('projectHostedRecords')
      .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
        q
          .eq('projectId', head.projectId)
          .eq('kind', 'issue')
          .eq('key', head.key)
          .eq('version', version)
          .eq('lifecyclePlanId', undefined),
      )
      .unique();
    if (row) evidenceBytes += getDocumentSize(row);
    return row;
  };
  const body = async (row: Record | null) => {
    if (!row || row.purged) return null;
    const evidence = planningHistoryBudget(snapshotBytes, Infinity);
    try {
      const item = await recordSnapshot(ctx, partition, row, evidence);
      return item?.version === row.version && item.id === head.key && item.status === row.status
        ? item
        : null;
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'SOURCE_UNAVAILABLE') return null;
      throw error;
    } finally {
      evidenceBytes += evidence.readBytes;
    }
  };
  const latest = head.value === undefined ? await exact(head.version) : null;
  const current: Snapshot | null =
    head.value === undefined
      ? latest?._id === head.recordId
        ? await body(latest)
        : null
      : JSON.parse(head.value);
  if (
    !current ||
    current.id !== head.key ||
    current.version !== head.version ||
    current.status !== head.status
  )
    return blocked();
  const seekClose = current.status === 'closed' || (isShelved(current.status) && current.was === 'closed');
  if (current.purged)
    return {
      times: { version: head.version, lastStatusChangeAt: null, closeKept: null, closedAt: null },
      readBytes: readBytes(),
    };
  const resume =
    cursor?.key === head.key &&
    cursor.recordId === head.recordId &&
    cursor.version === head.version &&
    cursor.status === head.status
      ? cursor
      : undefined;
  let changeVersion = resume?.changeVersion;
  let closeVersion: number | undefined;
  let proved = false;
  let version: { version: number; status: string } = current;
  if (resume) {
    const anchor = await exact(resume.visitedVersion);
    if (!anchor || anchor.purged) return blocked();
    version = anchor;
  }
  const rows = ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q
        .eq('projectId', head.projectId)
        .eq('kind', 'issue')
        .eq('key', head.key)
        .lt('version', version.version),
    )
    .order('desc');
  if (version.version > 1) {
    for await (const previous of rows) {
      scan.record(previous);
      const changed = planningStatusTransition(version, previous);
      if (changed === null || previous.purged || previous.lifecyclePlanId) return blocked();
      if (changed) {
        changeVersion ??= version.version;
        if (!seekClose) {
          proved = true;
          break;
        }
        if (version.status === 'closed') {
          const shelved = isShelved(previous.status);
          const shelf = shelved ? await body(previous) : null;
          if (shelved && !shelf) return blocked();
          if (shelf?.was !== 'closed') {
            // A recorded shelf without `was` has no proved close to preserve.
            if (!shelved || shelf?.was !== undefined) closeVersion = version.version;
            proved = true;
            break;
          }
        }
      }
      version = previous;
      if (version.version === 1) break;
      // Finish one step even if its single header crosses the target; Convex caps a row at 1 MiB.
      if (readBytes() >= scanBytes)
        return {
          resume: {
            key: head.key,
            recordId: head.recordId,
            version: head.version,
            status: head.status,
            visitedVersion: version.version,
            ...(changeVersion === undefined ? {} : { changeVersion }),
          },
          readBytes: readBytes(),
        };
    }
  }
  if (version.version === 1) {
    changeVersion ??= 1;
    if (seekClose && version.status === 'closed') closeVersion ??= 1;
    proved = true;
  }
  if (!proved || changeVersion === undefined) return blocked();
  const at = async (n: number) => (n === head.version ? current : await body(await exact(n)));
  const change = await at(changeVersion);
  const close =
    closeVersion === undefined ? null : closeVersion === changeVersion ? change : await at(closeVersion);
  if (!change || (closeVersion !== undefined && !close)) return blocked();
  const lastStatusChangeAt = planningTime(change.at);
  const closeKept = planningTime(close?.at);
  return {
    times: {
      version: head.version,
      lastStatusChangeAt,
      closeKept,
      closedAt: current.status === 'closed' ? closeKept : null,
    },
    readBytes: readBytes(),
  };
}
