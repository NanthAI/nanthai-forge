// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { metricComposeMembershipRows } from './projectMetricComposeMembership';
import { recordVersion } from './projectHostedRecords';
import type { ComposeState } from './projectHostedComposeStore';
import { digest } from '../src/state/hash';
import { JournalNeeded } from './projectJournalStore';
import { composeManifestSchema, composePageSchema } from '../src/hosted-compose';
import type { metricRunRow } from '../src/self-metrics-run';
import { landingRequestOriginalDb } from './projectLandingRequestBody';
import { metricAliasRows } from './projectMetricAliasWriter';
import { metricAttemptIndexReady } from './projectLandingCapsuleMetrics';
import { metricRunKind, readMetricAttempt } from './projectMetricReadProjection';
import { metricAttemptSource, metricRequestRow } from './projectMetricSourceRow';

import type { MetricBootstrap } from './projectMetricContextBootstrap';
import { metricAliasGeneration, metricContextKey } from '../src/self-metrics-context';

type Stream = 'requests' | 'attempts' | 'runs';
type Bounds = { from: number; through: number; cursor: string | null; compactAttempts: boolean };

/** A retained source page supplies aliases with the canonical creation time. */
export async function bootstrapMetricRows(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  stream: Stream,
  { from, through, cursor, compactAttempts }: Bounds,
) {
  const options = { cursor, numItems: 48, maximumRowsRead: 48, maximumBytesRead: 384 * 1024 };
  if (stream === 'requests') {
    const rows = await landingRequestOriginalDb(ctx.db)
      .query('projectHostedLandingRequests')
      .withIndex('by_project', q =>
        q.eq('projectId', projectId).gte('_creationTime', from).lt('_creationTime', through),
      )
      .paginate(options);
    return {
      ...rows,
      page: rows.page.flatMap(source =>
        metricAliasRows(projectId, source.submissionId, {
          stream,
          sourceCreatedAt: source._creationTime,
          row: metricRequestRow(source),
        }),
      ),
    };
  }
  if (stream === 'attempts') {
    invariant(
      compactAttempts === (await metricAttemptIndexReady(ctx, projectId)),
      'EVIDENCE_CHANGED',
      'Restart the metrics bootstrap after the attempt index changed.',
    );
    if (!compactAttempts) {
      const rows = await ctx.db
        .query('projectHostedLandingAttempts')
        .withIndex('by_project', q =>
          q.eq('projectId', projectId).gte('_creationTime', from).lt('_creationTime', through),
        )
        .paginate(options);
      return {
        ...rows,
        page: rows.page.flatMap(source =>
          metricAliasRows(projectId, source.attemptId, {
            stream,
            sourceCreatedAt: source.sourceCreatedAt ?? source._creationTime,
            row: metricAttemptSource(source),
          }),
        ),
      };
    }
  }
  const rows = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q
        .eq('kind', stream === 'runs' ? metricRunKind : 'projectHostedLandingAttempts')
        .eq('projectId', projectId)
        .gte('sourceCreatedAt', from)
        .lt('sourceCreatedAt', through),
    )
    .paginate(options);
  return {
    ...rows,
    page: rows.page.flatMap(source =>
      metricAliasRows(projectId, (stream === 'runs' ? source.runId : source.attemptId)!, {
        stream,
        sourceCreatedAt: source.sourceCreatedAt!,
        row:
          stream === 'runs'
            ? (JSON.parse(source.value) as ReturnType<typeof metricRunRow>)
            : readMetricAttempt(source),
      }),
    ),
  };
}

export async function insertBootstrapMetricRows(
  ctx: MutationCtx,
  aliases: Omit<Doc<'projectMetricFacts'>, '_id' | '_creationTime'>[],
) {
  const inserted = await Promise.all(
    aliases.map(async alias => {
      const old = await ctx.db
        .query('projectMetricFacts')
        .withIndex('by_project_and_key_and_source_time_and_id', q =>
          q
            .eq('projectId', alias.projectId)
            .eq('key', alias.key)
            .eq('sourceCreatedAt', alias.sourceCreatedAt)
            .eq('sourceId', alias.sourceId),
        )
        .first();
      if (old) return 0;
      await ctx.db.insert('projectMetricFacts', alias);
      return 1;
    }),
  );
  return inserted.reduce<number>((sum, count) => sum + count, 0);
}

const rootKey = metricContextKey(metricAliasGeneration, '"bootstrap-root"');
export const bootstrapFact = (
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  key: string,
  sourceId: string,
) =>
  ctx.db
    .query('projectMetricFacts')
    .withIndex('by_project_and_key_and_source_time_and_id', q =>
      q.eq('projectId', projectId).eq('key', key).eq('sourceCreatedAt', 0).eq('sourceId', sourceId),
    );

/** Read one metadata page. Persist the exact next object before any R2 GET. */
export async function nextBootstrapRoot(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: MetricBootstrap,
) {
  if (!state.pending.length && !state.scannedComposes) {
    const rows = await ctx.db
      .query('projectHostedComposes')
      .withIndex('by_project_and_job', q => q.eq('projectId', projectId))
      .paginate({ cursor: state.cursor, numItems: 8, maximumRowsRead: 8, maximumBytesRead: 256 * 1024 });
    state.cursor = rows.continueCursor;
    state.scannedComposes = rows.isDone;
    for (const row of rows.page) {
      if (row._creationTime >= state.composesThrough) continue;
      const compose = JSON.parse(row.value) as Pick<ComposeState, 'inputs' | 'request'>;
      const inputs = composeManifestSchema.parse(compose.request.inputs);
      const pages = compose.inputs.pages;
      invariant(
        Number.isSafeInteger(pages) && pages >= 0 && pages <= inputs.pages,
        'EVIDENCE_CHANGED',
        'The retained compose prefix has an invalid page count.',
      );
      if (!inputs.count || !pages) continue;
      state.pending.push({
        root: inputs.root.sha256,
        pin: inputs.root,
        pagesLeft: pages,
        complete: pages === inputs.pages,
      });
    }
  }
  while (state.pending.length) {
    const selected = state.pending.shift()!;
    if (await bootstrapFact(ctx, projectId, rootKey, selected.root).first()) continue;
    state.root = selected;
    return;
  }
  state.root = null;
  if (state.scannedComposes) {
    state.phase = 'requests';
    state.cursor = null;
  }
}

async function laneStamp(ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string, version: number) {
  try {
    const lane = await recordVersion(ctx, projectId, 'lane', laneId, version);
    return lane?.parent ? { intentId: lane.parent, sourceCreatedAt: lane._creationTime } : null;
  } catch (error) {
    if (!(error instanceof JournalNeeded)) throw error;
    // The report also reads the retained version stamp from this journal index.
    const pin = error.index.records?.find(record => record[0] === version);
    return pin?.[4] ? { intentId: pin[4], sourceCreatedAt: pin[2] } : null;
  }
}

export async function advanceBootstrapCompose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: MetricBootstrap,
  page: string | null,
) {
  const root = state.root;
  if (root) {
    invariant(
      page !== null &&
        new TextEncoder().encode(page).length === root.pin.size &&
        digest(page) === root.pin.sha256,
      'SOURCE_HASH_MISMATCH',
      'Compose page differs from the pinned metadata.',
    );
    const selected = composePageSchema.parse(JSON.parse(page));
    const members = (
      await Promise.all(
        selected.entries.map(async entry => {
          if (!('laneId' in entry)) return null;
          const lane = await laneStamp(ctx, projectId, entry.laneId, entry.version);
          return lane ? { laneId: entry.laneId, head: entry.head, ...lane } : null;
        }),
      )
    ).flatMap(member => (member ? [member] : []));
    const last = root.pagesLeft === 1;
    invariant(
      last ? (selected.next === null) === root.complete : selected.next !== null,
      'EVIDENCE_CHANGED',
      'Compose prefix differs from the staged page count.',
    );
    state.aliases += await insertBootstrapMetricRows(
      ctx,
      metricComposeMembershipRows({
        projectId,
        root: root.root,
        page: root.pin.sha256,
        members,
      }),
    );
    state.composePages++;
    if (last && root.complete)
      await ctx.db.insert('projectMetricFacts', {
        projectId,
        key: rootKey,
        sourceCreatedAt: 0,
        sourceId: root.root,
        value: root.pin.sha256,
      });
    state.root = last ? null : { ...root, pin: selected.next!, pagesLeft: root.pagesLeft - 1 };
  } else invariant(page === null, 'EVIDENCE_CHANGED', 'No compose page is selected.');
  if (!state.root) await nextBootstrapRoot(ctx, projectId, state);
}
