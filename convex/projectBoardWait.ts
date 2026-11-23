// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { query } from './cliServer';
import { activeProject } from './projectAuthority';
import { finishReadReader } from './projectFinishReadReader';
import { boardWake } from './projectBoardDelivery';
import { peerLatestLanding } from './projectBoardPeerLanding';
import { mainEvidence } from './projectFailureCauseRead';
import { deployWaitStatus } from './projectDeployStore';
import { hostedStartMain } from './projectHostedChannels';
import { agentActor } from '../src/agent-slug';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const prefix = /^[0-9a-f]{8}[0-9a-f-]{0,28}$/;

/**
 * Wait for a peer Lane (feature board-wait): the CLI holds this as its one live subscription for the
 * length of the wait. No polling: Convex re-runs it only when a row it read changes, which is the
 * peer's Lane head row, the peer's overlap row (its saves and its landing stamp) and, with `laneId`,
 * the caller's own inbox row. Members with write access only, as presence; people as handles.
 *
 * Reads per run: access (finish-read projection, 1-2 rows), ≤2 head rows (prefix range), 1 overlap
 * row, for an open Lane its latest landing (≤3 rows: compose selection, compose, landing request),
 * and with `laneId` 1 inbox row (+ the ≤2-note delivery only when a note is new).
 */
export const peer = query({
  args: {
    projectId: v.id('hostedProjects'),
    /** The peer Lane: full id or a unique prefix of 8+ characters. */
    peer: v.string(),
    /** The caller's own Lane: a note to it ends the wait early (reason "message"). */
    laneId: v.optional(v.string()),
    after: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (rawCtx, input) => {
    try {
      const ctx = finishReadReader(rawCtx);
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to wait for a peer Lane.');
      await activeProject(ctx, input.projectId, user.subject);
      const ref = input.peer.toLowerCase();
      invariant(prefix.test(ref), 'BAD_ARGUMENT', 'peer is a Lane id or an 8+ character prefix.');
      const heads = await rawCtx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_key', q =>
          uuid.test(ref)
            ? q.eq('projectId', input.projectId).eq('kind', 'lane').eq('key', ref)
            : q.eq('projectId', input.projectId).eq('kind', 'lane').gte('key', ref).lt('key', `${ref}￿`),
        )
        .take(2);
      invariant(
        heads.length === 1,
        heads.length ? 'BAD_ARGUMENT' : 'NOT_FOUND',
        heads.length
          ? `Lane prefix ${ref} is ambiguous (${heads.map(head => head.key.slice(0, 13)).join(', ')}); use more characters.`
          : `No Lane ${ref} in this project.`,
      );
      const head = heads[0]!;
      invariant(head.key !== input.laneId, 'BAD_ARGUMENT', 'peer is another Lane, not your own.');
      const row = await rawCtx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', head.key))
        .unique();
      const landed = row?.landed && row.landed.laneHead === row.head ? row.landed : undefined;
      const closed = head.status === 'abandoned' || head.status === 'completed' || (row && !row.open);
      // An open Lane whose latest landing failed or was cancelled (or landed without closing it) is
      // done for a waiter too. Three bounded index reads, no new field or write.
      const landing =
        landed || closed
          ? null
          : await peerLatestLanding(rawCtx, {
              projectId: input.projectId,
              laneId: head.key,
              recordedAt: row?.presenceRow?.at,
            });
      const state = landed
        ? 'accepted'
        : head.status === 'abandoned'
          ? 'abandoned'
          : head.status === 'completed'
            ? 'completed'
            : row && !row.open
              ? 'closed'
              : landing?.phase === 'landed'
                ? 'accepted'
                : (landing?.outcome ?? 'open');
      const board =
        input.laneId && input.after !== undefined
          ? await boardWake(ctx, {
              projectId: input.projectId,
              viewer: user.subject,
              laneId: input.laneId,
              after: input.after,
            }).catch(() => undefined)
          : undefined;
      return canonicalPayload({
        peer: {
          laneId: head.key,
          ...(head.parent ? { intentId: head.parent } : {}),
          state,
          terminal: state !== 'open',
          ...(row ? { actor: agentActor(row.actor, row.agent) } : {}),
          ...(landed
            ? {
                receiptId: landed.receiptId,
                commit: landed.commit,
                at: landed.at,
              }
            : {}),
          ...(landing
            ? {
                landing: {
                  operationId: landing.operationId,
                  phase: landing.phase,
                  ...(landing.code ? { code: landing.code } : {}),
                },
              }
            : {}),
        },
        ...(board ? { board } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/**
 * Wait until main is green again (`wait {"main":"green"}`, friction 1e94d000): the CLI holds this as its
 * one live subscription. Red is the same reading a failed landing's `failureCause` uses (main-failing):
 * main's audit row has a red episode or its newest audit failed; green is a passing newest audit. Reads per run: access (1-2 rows) and
 * main's audit row (1). Convex re-runs it only when that row changes (an audit result or a landing's
 * audit bookkeeping); no polling, nothing after the waiter exits.
 */
export const main = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (rawCtx, input) => {
    try {
      const ctx = finishReadReader(rawCtx);
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to wait for main.');
      await activeProject(ctx, input.projectId, user.subject);
      const audit = await mainEvidence(rawCtx, input.projectId);
      // Green only on a passing audit; a newer audit still running keeps the wait; no audit at all is
      // said, never read as a pass (review of friction 1e94d000).
      const main = !audit
        ? { state: 'unreported' }
        : audit.result === 'failed' || audit.redSince
          ? { state: 'red', ...(audit.redSince ? { since: audit.redSince } : {}) }
          : audit.result === 'passed'
            ? { state: 'green' }
            : { state: 'pending' };
      return canonicalPayload({ main });
    } catch (error) {
      return report(error);
    }
  },
});

/**
 * Wait until a landing (by receiptId, sequence, or current main) is contained in a successful deploy
 * (`wait {"deploy": ...}`, Item 8b6efb50). ONE live Convex subscription on `projectDeploys`; re-runs
 * only when a deploy row changes. Zero polling, zero idle cost.
 */
export const deploy = query({
  args: {
    projectId: v.id('hostedProjects'),
    receiptId: v.optional(v.string()),
    sequence: v.optional(v.number()),
    target: v.optional(v.union(v.literal('convex'), v.literal('web'), v.literal('all'))),
  },
  returns: v.string(),
  handler: async (rawCtx, input) => {
    try {
      const ctx = finishReadReader(rawCtx);
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to wait for a deploy.');
      await activeProject(ctx, input.projectId, user.subject);
      let sequence = input.sequence;
      let receiptId: string | undefined;
      if (input.receiptId !== undefined) {
        const wanted = input.receiptId.trim().toLowerCase();
        invariant(
          wanted.length >= 8 && wanted.length <= 64,
          'BAD_ARGUMENT',
          'Pass a receipt id or at least 8 characters of one.',
        );
        const exact = await rawCtx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_receipt', q =>
            q.eq('projectId', input.projectId).eq('receiptId', wanted),
          )
          .unique();
        const found = exact
          ? [exact]
          : await rawCtx.db
              .query('projectHostedAcceptances')
              .withIndex('by_project_and_receipt', q =>
                q
                  .eq('projectId', input.projectId)
                  .gte('receiptId', wanted)
                  .lt('receiptId', `${wanted}\uffff`),
              )
              .take(2);
        invariant(found.length, 'NOT_FOUND', `No landing in this project has receipt id ${wanted}.`);
        invariant(
          found.length === 1,
          'AMBIGUOUS_ID',
          `Receipt prefix ${wanted} matches more than one landing; pass more characters.`,
        );
        sequence = found[0]!.sequence;
        receiptId = found[0]!.receiptId;
      } else if (sequence === undefined) {
        const current = await hostedStartMain(rawCtx, input.projectId);
        sequence = current.sourceRevision;
      }
      invariant(
        Number.isSafeInteger(sequence) && sequence > 0,
        'BAD_ARGUMENT',
        'Select a positive landing sequence or receipt id.',
      );
      const target = input.target ?? 'all';
      const status = await deployWaitStatus(rawCtx, input.projectId, sequence, target);
      return canonicalPayload({
        deploy: {
          sequence,
          ...(receiptId ? { receiptId } : {}),
          target,
          state: status.state,
          deploys: status.deploys,
        },
      });
    } catch (error) {
      return report(error);
    }
  },
});
