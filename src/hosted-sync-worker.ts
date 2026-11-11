// SPDX-License-Identifier: Apache-2.0
import { hasConflictMarkers } from './conflict-markers.js';
import { composeStack } from './native-stack-compose.js';
import { NativeSource, overlappingPaths, type NativeFile } from './native-source.js';
import { compensatingState } from './compensating-revert.js';
import { conflictPlan } from './sync-conflict-plan.js';
import { LazyMergeSource, lazyMerge } from './hosted-merge-reader.js';
import { composeConflictPageSchema } from './hosted-compose.js';
import { syncInputSchema, syncOutputSchema } from './hosted-sync.js';
import { saveBytes, savePin } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { ForgeError, invariant } from './errors.js';
import type { SourceWorkerReader } from './hosted-source-worker-reader.js';
import type { WorkerPin } from './hosted-source-worker-format.js';
import { resolveDocsComposition } from './native-docs-resolve.js';
import { docsMerge } from './docs-resolution.js';

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
    reader.expectStates([work.previous.object.sha256, work.accepted.object.sha256]);
    await reader.files([work.previous, work.accepted]);
    const head = await calculate(() =>
      compensatingState(source, work.previous.object.sha256, work.accepted.object.sha256, plan.at),
    );
    result = { status: 'merged', state: { sha256: head, size: source.object(head).length } };
  } else if (work.mode === 'resolve') {
    // The draft manifest and the first conflict page are read next; fetch them in the same wave.
    const first = work.resolution.conflicts;
    reader.expectStates([work.left.object.sha256, work.resolution.draftHead]);
    await reader.prefetch(
      [work.left, ...(first.size <= 2 * 1024 * 1024 ? [{ object: first, recipe: null }] : [])],
      [work.resolution.draftHead],
    );
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
    // Issue 113bc7b3: a conflict file placed without markers holds one side unchanged (a binary
    // conflict, or one side kept whole). Resolving it as is would drop the other side's change
    // silently, so it needs an edit, the other side's bytes, or an explicit keep.
    const keep = new Set(work.keep ?? []),
      unchanged: string[] = [];
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
        // conflicts retain the left side unchanged and need no marker parsing, but must
        // not stay unchanged unless kept explicitly.
        if (!original || original.blob === conflict.left?.blob) {
          const same = original?.blob === file?.blob && original?.mode === file?.mode;
          if (same && !keep.has(conflict.path)) unchanged.push(conflict.path);
          continue;
        }
        if (!file) continue;
        if (source.resolvedContent) {
          source.resolvedContent(file);
          continue;
        }
        const bytes = await resolveCalculate(() => source.object(file.blob));
        invariant(
          !hasConflictMarkers(bytes),
          'CONFLICT_MARKERS',
          `Resolve the conflict markers before completing resolution: ${file.path}.`,
        );
      }
      pin = page.next;
    }
    if (unchanged.length) throw unchangedConflictSides(unchanged, resolution);
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
      // Both tips and their merge bases in one wave, not one miss round each.
      const states = [left, right, ...source.mergeBases(left, right)];
      reader.expectStates(states);
      await reader.prefetch([], states);
    } else {
      left = work.left.object.sha256;
      right = work.right.object.sha256;
      reader.expectStates([
        left,
        right,
        ...(work.stackBase ? [work.stackBase.object.sha256] : source.mergeBases(left, right)),
      ]);
      // The merge base manifests are read with the tips (a stack sync's base is its stack parent).
      await reader.prefetch(
        [work.left, work.right, ...(work.stackBase ? [work.stackBase] : [])],
        work.stackBase ? [] : source.mergeBases(left, right),
      );
    }
    let merged: { head?: string; conflicts: string[] } = await calculate(() => {
      source.state(left);
      source.state(right);
      return work.mode === 'sync' && work.stackBase
        ? composeStack(source, left, right, work.stackBase.object.sha256, plan.message, plan.at)
        : source.compose(left, right, plan.message, plan.at, { insertionOrder: 'right-first' });
    });
    // A Lane sync whose only conflicts are Markdown docs takes native finish's rule (Lane left,
    // main right, as this sync merges). Explicit resolutions and stacked syncs keep their conflicts.
    let docs: ReturnType<typeof docsMerge>;
    if (!merged.head && work.mode === 'sync' && !work.stackBase) {
      const resolved = await calculate(() =>
        resolveDocsComposition(source, left, right, plan.message, plan.at),
      );
      if (resolved) {
        merged = { head: resolved.head, conflicts: [] };
        docs = docsMerge(resolved.paths);
      }
    }
    if (merged.head) {
      invariant(work.mode === 'sync', 'SOURCE_JOB_INVALID', 'The original Candidate must retain a conflict.');
      result = {
        status: merged.head === left ? 'up-to-date' : 'merged',
        state: { sha256: merged.head, size: source.object(merged.head).length },
        ...(docs ? { docs } : {}),
      };
    } else {
      const pending = await calculate(() =>
        conflictPlan(
          source,
          left,
          right,
          // A landing resolution merges the Lane (right) into main (left); a sync the reverse.
          work.mode === 'resolution' ? ['main', 'lane'] : ['lane', 'target'],
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
/** The structured refusal for conflict files still holding one side unchanged. In a Candidate
 * resolution the draft holds main's side (left) and the Lane is right; in a Lane sync the
 * draft holds the Lane's side and the sync target is right. */
export function unchangedConflictSides(
  paths: string[],
  resolution: { candidateId: string | null; left: string; right: string },
) {
  const held = resolution.candidateId ? "main's version" : "the Lane's version",
    other = resolution.candidateId ? "the Lane's version" : "the sync target's version",
    shown = paths.slice(0, 20);
  return new ForgeError(
    'CONFLICT_SIDE_REQUIRED',
    `${shown.join(', ')}${paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ''} ` +
      `${paths.length === 1 ? 'still holds' : 'still hold'} ${held} unchanged, without conflict markers; resolving now would drop ${other}. ` +
      `Edit each file, or write ${other} (show {"state":"${resolution.right}","path":"PATH"}), ` +
      `or keep ${held} explicitly with resolve keep:["PATH"], then resolve again.`,
    undefined,
    { paths: shown, more: paths.length - shown.length, held, other, otherState: resolution.right },
  );
}
