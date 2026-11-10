// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  hostedProvenanceSchema,
  provenanceCursorSchema,
  provenanceHistoryReply,
  type provenanceFrameSchema,
} from './hosted-provenance-schema.js';
import { hostedRecordSchema } from './hosted-records.js';
import {
  validateComposePage,
  composeLaneSchema,
  composeDependencySchema,
  buildComposePages,
} from './hosted-compose.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { clientCacheRoot } from './root-paths.js';
import { parseNativeState } from './state/format.js';
import { reviewPaths } from './source-review-format.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { canonicalProvenancePlan } from './hosted-provenance-plan.js';
import { readFileProvenance } from './view-provenance.js';
import { invariant } from './errors.js';
import { memberDataNotice } from './member-data-notice.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
const emptyComposePage = buildComposePages([]).manifest.root;
type Frame = z.infer<typeof provenanceFrameSchema>;

/** One changed file and <=20 canonical Lane versions per page. Three metadata queries (root,
 * history, final authority), batched object descriptor pages and R2 GETs only for selected bytes;
 * no per-item Convex calls, full Work load, writes, subscription or idle traffic. */
export async function provenanceHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedProvenanceSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Invalid provenance parameters. Use provenance --help.');
  const command = parsed.data;
  const root = hostedRecordSchema.options[3].parse(
    await transport.query('projectHostedCompose:candidate', { candidateId: command.candidateId }),
  );
  invariant(root.id === command.candidateId, 'HOSTED_PROTOCOL_INVALID', 'Candidate identity differs.');
  invariant(root.result.status === 'clean', 'VIEW_CONFLICT', 'Select a clean Candidate for file provenance.');
  const selection = canonicalPayload({
    projectId: transport.address.projectId,
    candidateId: root.id,
    file: command.file ?? null,
    lines: command.lines,
  });
  let retained: z.infer<typeof provenanceCursorSchema> | undefined;
  if (command.cursor !== undefined) {
    try {
      retained = provenanceCursorSchema.parse(JSON.parse(command.cursor));
    } catch {
      invariant(false, 'BAD_ARGUMENT', 'Use the original provenance cursor.');
    }
    invariant(
      retained.selection === selection &&
        retained.base === root.base.head &&
        retained.head === root.result.head,
      'BAD_ARGUMENT',
      'Continue the original pinned Candidate, file and lines selection.',
    );
  }
  const objects = new ConvexLaneTransport(transport.exchange);
  const cache = new HostedCheckoutCache(clientCacheRoot(transport.root), objects);
  const read = (id: string) => readFileSync(join(cache.objects, id));
  await cache.ensure([root.base.head, root.result.head, root.inputs.sha256, root.dependencies.sha256]);
  const changes = reviewPaths(
    parseNativeState(read(root.base.head)).files,
    parseNativeState(read(root.result.head)).files,
  ).filter(f => f.status !== 'unchanged' && (!command.file || f.path === command.file));
  const fileIndex = retained?.fileIndex ?? 0;
  invariant(fileIndex <= changes.length, 'BAD_ARGUMENT', 'Provenance cursor is beyond the selected files.');
  const frameFor = (candidate: typeof root): Frame[] => {
    invariant(candidate.result.status === 'clean', 'VIEW_CONFLICT', 'Dependency has no clean source.');
    const frames: Frame[] = [
      {
        candidateId: candidate.id,
        head: candidate.result.head,
        kind: 'dependencies',
        page: candidate.dependencies,
        index: 0,
        history: null,
      },
      {
        candidateId: candidate.id,
        head: candidate.result.head,
        kind: 'inputs',
        page: candidate.inputs,
        index: 0,
        history: null,
      },
    ];
    const nonempty = frames.filter(
      frame => frame.page.sha256 !== emptyComposePage.sha256 || frame.page.size !== emptyComposePage.size,
    );
    return candidate.id === root.id
      ? nonempty.filter(frame => {
          const page = validateComposePage(JSON.parse(read(frame.page.sha256).toString('utf8')));
          return page.entries.length > 0 || page.next !== null;
        })
      : nonempty;
  };
  const frames = retained?.frames ?? frameFor(root);
  const seen = retained?.seen ?? [root.id];
  let fileResult: unknown = null,
    why: unknown[] = [],
    dependency: unknown = null;
  let sourceBytes = 0,
    downloadedSourceBytes = 0,
    historyVersions = 0,
    composePages = 0;
  const selected = changes[fileIndex];
  if (selected) {
    // Empty compose pages require no metadata call and do not become extra caller steps.
    while (frames.length && composePages < 2) {
      composePages++;
      const frame = frames.at(-1)!;
      await cache.ensure([frame.page.sha256]);
      const page = validateComposePage(JSON.parse(read(frame.page.sha256).toString('utf8')));
      invariant(
        read(frame.page.sha256).length === frame.page.size,
        'SOURCE_HASH_MISMATCH',
        'Compose page size differs.',
      );
      invariant(
        frame.index <= page.entries.length,
        'BAD_ARGUMENT',
        'Provenance cursor is beyond its compose page.',
      );
      const advance = () => {
        if (page.next) {
          frame.page = page.next;
          frame.index = 0;
          frame.history = null;
        } else frames.pop();
      };
      if (frame.index === page.entries.length) {
        advance();
        continue;
      }
      if (frame.kind === 'dependencies') {
        const entry = composeDependencySchema.parse(page.entries[frame.index++]!);
        if (seen.includes(entry.candidateId)) continue;
        const reply = provenanceHistoryReply.parse(
          await transport.query('projectHostedProvenanceRead:read', {
            request: canonicalPayload({ candidateId: entry.candidateId, lanes: [], cursor: null }),
          }),
        );
        invariant(
          reply.candidate.result.status === 'clean' && reply.candidate.result.head === entry.head,
          'SOURCE_UNAVAILABLE',
          'Pinned dependency head differs.',
        );
        seen.push(entry.candidateId);
        if (frame.index === page.entries.length) advance();
        frames.push(...frameFor(reply.candidate));
        dependency = { candidateId: entry.candidateId, head: entry.head };
        why = reply.why;
        break;
      }
      const lanes = page.entries.map(value => composeLaneSchema.parse(value));
      const firstHistoryPage =
        frame.candidateId === root.id &&
        frame.page.sha256 === root.inputs.sha256 &&
        frame.index === 0 &&
        frame.history === null;
      const history = provenanceHistoryReply.parse(
        await transport.query('projectHostedProvenanceRead:read', {
          request: canonicalPayload({
            candidateId: frame.candidateId,
            lanes,
            cursor: frame.history ?? { index: frame.index, cursor: null },
          }),
        }),
      );
      invariant(
        history.candidate.result.status === 'clean' && history.candidate.result.head === frame.head,
        'SOURCE_UNAVAILABLE',
        'Pinned evidence Candidate differs.',
      );
      historyVersions = history.histories.reduce((n, h) => n + h.versions.length, 0);
      const stateIds = [
        ...new Set(
          history.histories.flatMap(item => [
            item.selected.head,
            ...(item.previous ? [item.previous.head] : []),
            ...item.versions.map(v => v.lane.head),
          ]),
        ),
      ];
      await cache.ensure(stateIds);
      const states = new Map(
        stateIds.map(id => {
          const value = parseNativeState(read(id));
          return [id, { ...value, files: value.files.filter(f => f.path === selected.path) }] as const;
        }),
      );
      if (history.nextCursor) {
        frame.history = history.nextCursor;
        frame.index = history.nextCursor.index;
      } else advance();
      // A first complete input page with no dependency work is the whole selected Candidate.
      const emptyDependencies = validateComposePage(
        JSON.parse(read(root.dependencies.sha256).toString('utf8')),
      );
      const complete =
        firstHistoryPage &&
        !history.nextCursor &&
        !page.next &&
        emptyDependencies.entries.length === 0 &&
        emptyDependencies.next === null;
      const plan = canonicalProvenancePlan(
        selected.path,
        selected.before,
        selected.after,
        history,
        states,
        complete,
      );
      const ids = [
        ...new Set(
          [
            plan.before?.blob,
            plan.after?.blob,
            ...(command.lines
              ? plan.contributors.flatMap(c => c.saves.flatMap(s => [s.before?.blob, s.after?.blob]))
              : []),
          ].filter((id): id is string => !!id),
        ),
      ];
      const pins = ids.length ? await objects.objects(ids) : [];
      const sizes = new Map(pins.map(pin => [pin.sha256, pin.size]));
      const byteCache = new HostedCheckoutCache(clientCacheRoot(transport.root), {
        objects: async digests => digests.map(id => pins.find(pin => pin.sha256 === id)!),
        downloadToFile: objects.downloadToFile.bind(objects),
        downloadFiles: objects.downloadFiles.bind(objects),
      });
      if (pins.every(pin => pin.size <= 1024 * 1024)) {
        await byteCache.ensure(pins.map(pin => pin.sha256));
        sourceBytes = pins.reduce((n, pin) => n + pin.size, 0);
        downloadedSourceBytes = byteCache.downloadedBytes;
      }
      const file = await readFileProvenance(
        plan,
        async id => read(id),
        command.lines,
        id => sizes.get(id)!,
      );
      fileResult = {
        ...file,
        ...(command.lines && !plan.historyComplete && 'lines' in file && file.lines?.status === 'available'
          ? {
              lines: {
                ...file.lines,
                status: 'partial',
                reason: 'Only this pinned evidence page was attributed.',
              },
            }
          : {}),
      };
      why = history.why;
      break;
    }
  }
  let nextFile = fileIndex;
  if (!frames.length) {
    nextFile++;
    if (nextFile < changes.length) {
      frames.push(...frameFor(root));
      seen.splice(0, seen.length, root.id);
    }
  }
  const done = !selected || nextFile >= changes.length;
  await transport.query('projectHostedCompose:candidate', { candidateId: root.id });
  return {
    sourceContext: { candidateId: root.id, base: root.base.head, head: root.result.head, scope: 'saved' },
    result: {
      files: fileResult ? [fileResult] : [],
      why,
      ...(dependency ? { dependency } : {}),
      nextCursor: done
        ? null
        : canonicalPayload({
            selection,
            base: root.base.head,
            head: root.result.head,
            fileIndex: nextFile,
            frames,
            seen,
          }),
      coverage: {
        complete: !!fileResult && (fileResult as { historyComplete?: boolean }).historyComplete === true,
        note: 'One file and a bounded saved-history page. Continue all pages; partial evidence never proves complete attribution. Rationale is current.',
      },
      cost: {
        downloadedBytes: cache.downloadedBytes + downloadedSourceBytes,
        sourceBytes,
        historyVersions,
        composePages,
        idleCalls: 0,
      },
      notice: memberDataNotice,
    },
  };
}
