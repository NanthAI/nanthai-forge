// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import type { ConvexLaneTransport } from './hosted-lane-transport.js';
import { contextualHunks } from './review-hunks.js';
import { REVIEW_MAX_FILE_BYTES } from './review-hunks-core.js';
import type { ReviewPath } from './source-review-format.js';
import { isTextBytes, sourceTextLines } from './text-bytes.js';

// The hunk engine compares at most 1 MiB per version. Bound each page to one such
// pair's worth of source, even when the caller asks for a much larger reply.
const maxSourceBytes = 2 * REVIEW_MAX_FILE_BYTES;
const empty = Buffer.alloc(0);
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const modes = { file: '100644', executable: '100755', symlink: '120000', gitlink: '160000' } as const;
type Diff = ReturnType<typeof contextualHunks>;

function fitDiff(diff: Diff, budget: number, requiredByteBudget: number) {
  const bounded = { ...diff, hunks: [] as Diff['hunks'], truncated: true, requiredByteBudget };
  let remaining = budget - jsonBytes(bounded);
  for (const hunk of diff.hunks) {
    const partial = { ...hunk, lines: [] as typeof hunk.lines, beforeLines: 0, afterLines: 0 };
    // Reserve a comma and room for the counts to grow.
    remaining -= jsonBytes(partial) + 16;
    if (remaining <= 0) break;
    for (const line of hunk.lines) {
      remaining -= jsonBytes(line) + 1;
      if (remaining < 0) break;
      partial.lines.push(line);
      if (line.kind !== 'added') partial.beforeLines++;
      if (line.kind !== 'removed') partial.afterLines++;
    }
    if (partial.lines.length) bounded.hunks.push(partial);
    if (partial.lines.length !== hunk.lines.length) break;
  }
  return bounded;
}

function unifiedFileHunks(
  item: ReviewPath,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  diff: Diff,
  fromHunk = 0,
) {
  const header = [`diff --git a/${item.path} b/${item.path}`];
  if (fromHunk === 0) {
    if (!item.before) header.push(`new file mode ${modes[item.after!.mode]}`);
    else if (!item.after) header.push(`deleted file mode ${modes[item.before.mode]}`);
    else if (item.before.mode !== item.after.mode)
      header.push(`old mode ${modes[item.before.mode]}`, `new mode ${modes[item.after.mode]}`);
  }
  const fromPath = item.before ? `a/${item.path}` : '/dev/null',
    toPath = item.after ? `b/${item.path}` : '/dev/null';
  if (!isTextBytes(beforeBytes) || !isTextBytes(afterBytes) || diff.encoding === 'not-utf-8')
    return {
      header: [...header, `Binary files ${fromPath} and ${toPath} differ (Binary files differ)`].join('\n'),
      hunks: [] as string[],
    };
  if (!diff.hunks.length) return { header: header.join('\n'), hunks: [] as string[] };
  header.push(`--- ${fromPath}`, `+++ ${toPath}`);
  const beforeTotal = sourceTextLines(beforeBytes),
    afterTotal = sourceTextLines(afterBytes),
    beforeHasNl = beforeBytes.length > 0 && beforeBytes[beforeBytes.length - 1] === 10,
    afterHasNl = afterBytes.length > 0 && afterBytes[afterBytes.length - 1] === 10;
  type Step = { kind: 'context' | 'removed' | 'added'; text: string; noEol: boolean };
  const hunks = diff.hunks.map(hunk => {
    let beforeLine = hunk.beforeStart,
      afterLine = hunk.afterStart;
    const steps: Step[] = [];
    for (const line of hunk.lines) {
      const bLine = beforeLine,
        aLine = afterLine;
      if (line.kind !== 'added') beforeLine++;
      if (line.kind !== 'removed') afterLine++;
      const bSentinel = line.kind !== 'added' && beforeHasNl && bLine === beforeTotal + 1,
        aSentinel = line.kind !== 'removed' && afterHasNl && aLine === afterTotal + 1;
      if (line.kind === 'removed') {
        if (!bSentinel)
          steps.push({ kind: 'removed', text: line.text, noEol: !beforeHasNl && bLine === beforeTotal });
      } else if (line.kind === 'added') {
        if (!aSentinel)
          steps.push({ kind: 'added', text: line.text, noEol: !afterHasNl && aLine === afterTotal });
      } else if (bSentinel && aSentinel) {
        continue;
      } else if (bSentinel) {
        steps.push({ kind: 'added', text: line.text, noEol: !afterHasNl && aLine === afterTotal });
      } else if (aSentinel) {
        steps.push({ kind: 'removed', text: line.text, noEol: !beforeHasNl && bLine === beforeTotal });
      } else {
        const bNoEol = !beforeHasNl && bLine === beforeTotal,
          aNoEol = !afterHasNl && aLine === afterTotal;
        if (bNoEol === aNoEol) steps.push({ kind: 'context', text: line.text, noEol: bNoEol });
        else
          steps.push(
            { kind: 'removed', text: line.text, noEol: bNoEol },
            { kind: 'added', text: line.text, noEol: aNoEol },
          );
      }
    }
    const ordered: Step[] = [];
    for (let i = 0; i < steps.length;) {
      if (steps[i]!.kind === 'context') {
        ordered.push(steps[i++]!);
        continue;
      }
      let end = i;
      while (end < steps.length && steps[end]!.kind !== 'context') end++;
      const run = steps.slice(i, end);
      ordered.push(...run.filter(s => s.kind === 'removed'), ...run.filter(s => s.kind === 'added'));
      i = end;
    }
    const beforeCount = ordered.filter(s => s.kind !== 'added').length,
      afterCount = ordered.filter(s => s.kind !== 'removed').length;
    const body = [
      `@@ -${beforeCount ? hunk.beforeStart : 0},${beforeCount} +${afterCount ? hunk.afterStart : 0},${afterCount} @@`,
    ];
    for (const step of ordered) {
      const prefix = step.kind === 'context' ? ' ' : step.kind === 'removed' ? '-' : '+';
      body.push(`${prefix}${step.text}`);
      if (step.noEol) body.push('\\ No newline at end of file');
    }
    return body.join('\n');
  });
  return { header: header.join('\n'), hunks };
}

async function prepareDiffWindow(
  root: string,
  objects: ConvexLaneTransport,
  window: ReviewPath[],
  byteBudget: number,
) {
  // The one metadata page covers both versions of up to 50 paths.
  const blobs = (item: ReviewPath) => [item.before?.blob, item.after?.blob].filter(id => id !== undefined);
  const ids = [...new Set(window.flatMap(blobs))];
  const pins = new Map((ids.length ? await objects.objects(ids) : []).map(pin => [pin.sha256, pin]));
  const selection = [];
  const selectedIds = new Set<string>();
  let plannedBytes = 0,
    ordinaryBytes = 0;
  for (const item of window) {
    const itemIds = blobs(item);
    const sizes = itemIds.map(id => pins.get(id)!.size);
    const size = sizes.reduce((sum, bytes) => sum + bytes, 0);
    if (sizes.some(bytes => bytes > REVIEW_MAX_FILE_BYTES)) {
      selection.push({
        item,
        omission: { path: item.path, reason: 'source-too-large' as const, sourceBytes: size },
      });
      continue;
    }
    if (plannedBytes + size > maxSourceBytes) break;
    // Keep the usual small-file source window. A large pair may still have a small hunk,
    // so let it use the separate source allowance.
    if (size <= byteBudget) {
      if (ordinaryBytes + size > byteBudget) break;
      ordinaryBytes += size;
    }
    plannedBytes += size;
    selection.push({ item });
    for (const id of itemIds) selectedIds.add(id);
  }
  // Reuse signatures from discovery. No per-file descriptor requests.
  const cache = new HostedCheckoutCache(root, {
    objects: async digests => digests.map(id => pins.get(id)!),
    downloadToFile: objects.downloadToFile.bind(objects),
    downloadFiles: objects.downloadFiles.bind(objects),
  });
  let sourceBytes = 0;
  const verified = new Set<string>();
  const materialize = async (ids: string[]) => {
    const pending = [...new Set(ids)].filter(id => !verified.has(id));
    if (!pending.length) return;
    await cache.ensure(pending);
    for (const id of pending) {
      sourceBytes += pins.get(id)!.size;
      verified.add(id);
    }
  };
  // Batch cold downloads to preserve packed R2 runs. Reverify warm files only as
  // they are compared, so paging does not repeatedly hash the unread tail.
  await materialize([...selectedIds].filter(id => !checkoutPathExists(join(cache.objects, id))));
  const read = (id: string | undefined) => (id ? readFileSync(join(cache.objects, id)) : empty);
  return {
    blobs,
    selection,
    materialize,
    read,
    cost: (outputBytes: number) => ({
      sourceBytes,
      outputBytes,
      downloadedBytes: cache.downloadedBytes,
      metadataPages: ids.length ? 1 : 0,
    }),
  };
}

export async function readHostedDiffPage(
  root: string,
  objects: ConvexLaneTransport,
  window: ReviewPath[],
  byteBudget: number,
) {
  const { blobs, selection, materialize, read, cost } = await prepareDiffWindow(
    root,
    objects,
    window,
    byteBudget,
  );
  const items = [],
    omitted = [];
  let outputBytes = 0;
  for (const { item, omission } of selection) {
    if (omission) {
      omitted.push(omission);
      continue;
    }
    await materialize(blobs(item));
    const before = read(item.before?.blob),
      after = read(item.after?.blob),
      remaining = byteBudget - outputBytes;
    let diff: Diff & { requiredByteBudget?: number } = contextualHunks(before, after, 3, true);
    let size = jsonBytes(diff);
    if (size > remaining) {
      // Context is optional in a tight reply. Save the file for the next pinned page
      // if its changed lines can get more room there.
      diff = contextualHunks(before, after, 0, true);
      size = jsonBytes(diff);
      if (size > remaining) {
        if (items.length) break;
        const bounded = fitDiff(diff, remaining, size);
        diff = bounded;
        size = jsonBytes(bounded);
      }
    }
    outputBytes += size;
    items.push({ ...item, ...diff });
  }
  return {
    items,
    omitted,
    cost: cost(outputBytes),
  };
}

export async function readHostedUnifiedDiffPage(
  root: string,
  objects: ConvexLaneTransport,
  window: ReviewPath[],
  byteBudget: number,
  startHunk = 0,
) {
  const { blobs, selection, materialize, read, cost } = await prepareDiffWindow(
    root,
    objects,
    window,
    byteBudget,
  );
  const blocks: string[] = [],
    omitted = [];
  let outputBytes = 0,
    consumedFiles = 0,
    shownFiles = 0,
    nextHunk: number | null = null;
  for (let i = 0; i < selection.length; i++) {
    const { item, omission } = selection[i]!;
    if (omission) {
      invariant(i > 0 || startHunk === 0, 'BAD_ARGUMENT', 'Diff hunk cursor is beyond the file hunks.');
      omitted.push(omission);
      consumedFiles = i + 1;
      shownFiles = i + 1;
      continue;
    }
    await materialize(blobs(item));
    const before = read(item.before?.blob),
      after = read(item.after?.blob);
    const diff = contextualHunks(before, after, 3, true);
    const fromHunk = i === 0 ? startHunk : 0;
    const { header, hunks } = unifiedFileHunks(item, before, after, diff, fromHunk);
    invariant(
      fromHunk === 0 || fromHunk < hunks.length,
      'BAD_ARGUMENT',
      'Diff hunk cursor is beyond the file hunks.',
    );
    const headerText = `${header}\n`,
      headerBytes = Buffer.byteLength(headerText);
    if (!hunks.length) {
      if (blocks.length && outputBytes + headerBytes > byteBudget) break;
      blocks.push(headerText);
      outputBytes += headerBytes;
      consumedFiles = i + 1;
      shownFiles = i + 1;
      continue;
    }
    const taken: string[] = [];
    let fileBytes = headerBytes,
      h = fromHunk;
    for (; h < hunks.length; h++) {
      const hunkText = `${hunks[h]!}\n`,
        hunkBytes = Buffer.byteLength(hunkText);
      if (outputBytes + fileBytes + hunkBytes > byteBudget) break;
      taken.push(hunkText);
      fileBytes += hunkBytes;
    }
    if (!taken.length) {
      if (blocks.length) break;
      omitted.push({
        path: item.path,
        reason: 'hunk-too-large' as const,
        requiredByteBudget: headerBytes + Buffer.byteLength(`${hunks[fromHunk]!}\n`),
      });
      consumedFiles = i + 1;
      shownFiles = i + 1;
      continue;
    }
    blocks.push(headerText + taken.join(''));
    outputBytes += fileBytes;
    shownFiles = i + 1;
    if (h < hunks.length) {
      consumedFiles = i;
      nextHunk = h;
      break;
    }
    consumedFiles = i + 1;
  }
  return {
    diff: blocks.join(''),
    omitted,
    consumedFiles,
    shownFiles,
    nextHunk,
    cost: cost(outputBytes),
  };
}
