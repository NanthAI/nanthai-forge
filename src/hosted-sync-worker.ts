import { composeStack } from './native-stack-compose.js';
// SPDX-License-Identifier: Apache-2.0
import { NativeSource, overlappingPaths, type NativeFile } from './native-source.js';
import { compensatingState } from './compensating-revert.js';
import { conflictPlan } from './agent-sync.js';
import { LazyMergeSource, lazyMerge } from './hosted-merge-reader.js';
import { composeConflictPageSchema } from './hosted-compose.js';
import { syncInputSchema, syncOutputSchema } from './hosted-sync.js';
import { saveBytes, savePin } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';
import type { SourceWorkerReader } from './hosted-source-worker-reader.js';
import type { WorkerPin } from './hosted-source-worker-format.js';

/** Same native sync orientation and conflict marker plan, on immutable lazy inputs. */
export async function buildHostedSyncState(
  input: WorkerPin,
  value: unknown,
  reader: SourceWorkerReader,
  original: NativeSource,
  progress: () => Promise<void>,
) {
  const plan = syncInputSchema.parse(value),
    work = plan.work,
    source = original instanceof LazyMergeSource ? original : new LazyMergeSource(original.owner),
    calculate = <T>(action: () => T) => lazyMerge(reader, progress, action, source);
  const publishGenerated = async () => {
    await reader.publishGenerated(source, source.generated);
    source.generated.clear();
  };
  let result: typeof syncOutputSchema._output.result;
  if (work.mode === 'revert') {
    await reader.files([work.previous, work.accepted]);
    const head = await calculate(() =>
      compensatingState(source, work.previous.object.sha256, work.accepted.object.sha256, plan.at),
    );
    result = { status: 'merged', state: { sha256: head, size: source.object(head).length } };
  } else if (work.mode === 'resolve') {
    await reader.file(work.left);
    // Resolution follows only the saved draft lineage and selected conflict
    // files. Merge frontier prefetch would hydrate unrelated historical States.
    const resolveCalculate = <T>(action: () => T) => lazyMerge(reader, progress, action);
    const resolution = work.resolution;
    invariant(resolution.status === 'pending', 'SOURCE_JOB_INVALID', 'Select the pending resolution.');
    invariant(
      await resolveCalculate(() => source.contains(work.left.object.sha256, resolution.draftHead)),
      'WORK_STALE',
      'Resolution source no longer descends from its exact draft.',
    );
    const state = source.state(work.left.object.sha256);
    const draftFiles = new Map(
      (await resolveCalculate(() => source.state(resolution.draftHead).files)).map(file => [file.path, file]),
    );
    const currentFiles = new Map(state.files.map(file => [file.path, file]));
    let pin: WorkerPin | null = resolution.conflicts;
    const seen = new Set<string>();
    while (pin) {
      invariant(!seen.has(pin.sha256), 'SOURCE_HASH_MISMATCH', 'Conflict pages must advance.');
      seen.add(pin.sha256);
      const page = composeConflictPageSchema.parse(await reader.json(pin));
      invariant(
        page.left === resolution.left && page.right === resolution.right,
        'SOURCE_HASH_MISMATCH',
        'Resolve the original conflict source.',
      );
      if (!source.resolvedContent) {
        // Fixed workers resolve a whole conflict page together; distinct edited
        // blobs must not turn into a Convex descriptor request per file.
        await reader.resolveMany(
          page.paths.flatMap(conflict => {
            const original = draftFiles.get(conflict.path),
              file = currentFiles.get(conflict.path);
            return original && original.blob !== conflict.left?.blob && file ? [file.blob] : [];
          }),
        );
      }
      for (const conflict of page.paths) {
        const original = draftFiles.get(conflict.path),
          file = currentFiles.get(conflict.path);
        // Text drafts contain generated marker bytes. Binary and file/directory
        // conflicts retain the left side unchanged and need no marker parsing.
        if (!original || original.blob === conflict.left?.blob || !file) continue;
        if (source.resolvedContent) {
          source.resolvedContent(file);
          continue;
        }
        const bytes = await resolveCalculate(() => source.object(file.blob));
        invariant(
          !/^(<<<<<<< |>>>>>>> |=======\r?$)/m.test(bytes.toString('utf8')),
          'CONFLICT_MARKERS',
          `Resolve the conflict markers before completing resolution: ${file.path}.`,
        );
      }
      pin = page.next;
    }
    const head = await resolveCalculate(() =>
      source.writeState(state.files, [work.left.object.sha256, resolution.right], plan.message, plan.at),
    );
    result = {
      status: 'resolved',
      state: { sha256: head, size: source.object(head).length },
      resolution: { ...resolution, status: 'resolved' },
    };
  } else {
    let left: string,
      right: string,
      conflicts: WorkerPin | null = null;
    if (work.mode === 'resolution') {
      conflicts = work.conflicts;
      const page = composeConflictPageSchema.parse(await reader.json(conflicts));
      invariant(
        canonicalPayload(savePin(page)) === canonicalPayload(conflicts),
        'SOURCE_HASH_MISMATCH',
        'Conflict page differs from its exact pin.',
      );
      left = page.left;
      right = page.right;
    } else {
      await reader.files([work.left, work.right]);
      left = work.left.object.sha256;
      right = work.right.object.sha256;
    }
    const merged = await calculate(() => {
      source.state(left);
      source.state(right);
      return work.mode === 'sync' && work.stackBase
        ? composeStack(source, left, right, work.stackBase.object.sha256, plan.message, plan.at)
        : source.compose(left, right, plan.message, plan.at, { insertionOrder: 'right-first' });
    });
    if (merged.head) {
      invariant(work.mode === 'sync', 'SOURCE_JOB_INVALID', 'The original Candidate must retain a conflict.');
      result = {
        status: merged.head === left ? 'up-to-date' : 'merged',
        state: { sha256: merged.head, size: source.object(merged.head).length },
      };
    } else {
      const pending = await calculate(() =>
        conflictPlan(
          source,
          left,
          right,
          'target',
          work.mode === 'sync' ? work.stackBase?.object.sha256 : undefined,
        ),
      );
      const files: NativeFile[] = pending.files.map(file => ({
        path: file.path,
        mode: file.mode,
        blob: file.bytes ? source.put(file.bytes) : file.blob!,
      }));
      // Draft has only its left parent. Right becomes an ancestor on explicit resolved completion.
      const head = source.writeState(files, [left], plan.message, plan.at);
      if (!conflicts) {
        const details = await calculate(() =>
          source.mergeFiles(
            left,
            right,
            work.mode === 'sync' && work.stackBase ? new Set([work.stackBase.object.sha256]) : undefined,
            work.mode === 'sync' && work.stackBase ? new Set([work.stackBase.object.sha256]) : undefined,
            undefined,
            { insertionOrder: 'right-first' },
          ),
        );
        const byPath = new Map(details.conflicts.map(item => [item.path, item]));
        const l = new Map(source.state(left).files.map(file => [file.path, file])),
          r = new Map(source.state(right).files.map(file => [file.path, file]));
        const paths = [...new Set([...merged.conflicts, ...overlappingPaths(details.files)])].sort();
        const groups: (typeof composeConflictPageSchema._output.paths)[] = [];
        let group: typeof composeConflictPageSchema._output.paths = [];
        for (const path of paths) {
          const item = byPath.get(path),
            entry = {
              path,
              ...(item?.reason ? { reason: item.reason } : {}),
              base: item?.base ?? null,
              left: item?.left ?? l.get(path) ?? null,
              right: item?.right ?? r.get(path) ?? null,
            };
          if (group.length && (group.length === 100 || saveBytes([...group, entry]).length > 120 * 1024)) {
            groups.push(group);
            group = [];
          }
          group.push(entry);
        }
        if (group.length) groups.push(group);
        for (const paths of groups.reverse())
          conflicts = await reader.publish(
            Buffer.from(
              saveBytes(
                composeConflictPageSchema.parse({
                  schema: 1,
                  kind: 'forge-hosted-compose-conflicts',
                  left,
                  right,
                  paths,
                  next: conflicts,
                }),
              ),
            ),
          );
      }
      invariant(conflicts, 'SOURCE_JOB_INVALID', 'Retain the original conflicting inputs.');
      result = {
        status: 'conflict',
        state: { sha256: head, size: source.object(head).length },
        left,
        right,
        conflicts,
      };
    }
  }
  await publishGenerated();
  const output = await reader.publish(
    Buffer.from(
      saveBytes(
        syncOutputSchema.parse({
          schema: 1,
          kind: 'forge-hosted-sync-result',
          input,
          algorithm: plan.algorithm,
          result,
        }),
      ),
    ),
  );
  return {
    head: result.state.sha256,
    state: result.state,
    output,
    metrics: {
      ...reader.metrics,
      states: source.states.size,
      resolvedObjects: reader.resolvedObjects,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    },
  };
}
