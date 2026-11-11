// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { actionWithMappedResult, internalQuery } from './cliServer';
import { checkReader } from './projectHostedCheckRead';
import { checkReportsKey } from './projectHostedCheckReports';
import { loadHostedCheck } from './projectHostedCheckStore';
import { presignGet, r2Config } from './r2';
import { convexFetch } from './networkFetch';
import { canonicalPayload } from '../src/hosted-source-operation';
import { checkPin, type HostedCheckRun } from '../src/hosted-check';
import { semanticReportsSchema } from '../src/intent-semantic-conflict';
import { pageCheckReports } from '../src/check-report-detail';
import { invariant } from '../src/errors';
import { report } from './errors';
const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
/** Internal bytes are never exposed as a URL or key. The public action repeats the query's
 * access check and uses the same cliServer identity mapper on its final reply. */
export const retained = internalQuery({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    await checkReader(ctx, input.projectId);
    return canonicalPayload((await loadHostedCheck(ctx, input)).run);
  },
});
const detailAction = actionWithMappedResult((value, input) => {
  const { failed, files, cursor } = input as { failed?: boolean; files?: string[]; cursor?: string | null };
  return canonicalPayload(
    pageCheckReports(
      JSON.parse(value as string),
      { ...(failed === undefined ? {} : { failed }), ...(files ? { files } : {}) },
      cursor,
    ),
  );
});
export const reports = detailAction({
  args: {
    ...identity,
    failed: v.optional(v.boolean()),
    files: v.optional(v.array(v.string())),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.string(),
  handler: async (ctx, { failed: _failed, files: _files, cursor: _cursor, ...input }): Promise<string> => {
    void _failed;
    void _files;
    void _cursor;
    try {
      const run: HostedCheckRun = JSON.parse(
        await ctx.runQuery(makeFunctionReference<'query'>('projectHostedCheckDetail:retained'), input),
      );
      let reports = run.contractReports ?? {};
      if (run.reportPointer) {
        const pointer = run.reportPointer;
        const response = await convexFetch(await presignGet(r2Config(), checkReportsKey(run)));
        invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Retained check reports are unavailable.');
        const body = await response.text();
        invariant(
          new TextEncoder().encode(body).length === pointer.size,
          'EVIDENCE_CHANGED',
          'Retained check report size differs.',
        );
        reports = semanticReportsSchema.parse(JSON.parse(body));
        invariant(
          checkPin(reports) === pointer.digest && Object.keys(reports).length === pointer.files,
          'EVIDENCE_CHANGED',
          'Retained check reports differ from their pin.',
        );
      }
      return canonicalPayload(reports);
    } catch (error) {
      return report(error);
    }
  },
});
