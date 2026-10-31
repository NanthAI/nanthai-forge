// SPDX-License-Identifier: Apache-2.0
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { durableReplace } from './native-durability.js';
import { digest } from './hash.js';
import type { captureHostedSave } from './hosted-save-capture.js';

type Capture = Awaited<ReturnType<typeof captureHostedSave>>;
const modes = { file: '100644', executable: '100755', symlink: '120000', gitlink: '160000' } as const;

function text(bytes: Buffer): string | null {
  try {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return value.includes('\0') ? null : value;
  } catch {
    return null;
  }
}
function lines(value: string, prefix: string) {
  if (!value) return [];
  const result = value.split('\n');
  if (value.endsWith('\n')) result.pop();
  return [
    ...result.map(line => prefix + line),
    ...(value.endsWith('\n') ? [] : ['\\ No newline at end of file']),
  ];
}

/** Keep every unsaved edit before an abandon: one `patch -p1`/`git apply` file
 * with whole-file hunks against the Lane baseline, plus exact copies of files a
 * text patch cannot carry (binary, links, submodule pointers, unknown baseline).
 * Local disk only; the capture already holds the edited bytes. */
export function keepHostedEditsPatch(root: string, operationId: string, capture: Capture, captured: string) {
  const name = `${root}.kept-${operationId.slice(0, 8)}`,
    patch = `${name}.patch`,
    copies = `${name}-files`,
    objects = join(`${root}.forge-client`, 'objects');
  const blocks: string[] = [],
    copied: string[] = [];
  const read = (blob: string, path: string) => {
    const bytes = checkoutPathExists(path) ? readFileSync(path) : null;
    return bytes && digest(bytes) === blob ? bytes : null;
  };
  for (const change of capture.changes) {
    const { path, before, after } = change;
    const old = before
      ? before.mode === 'symlink' || before.mode === 'gitlink'
        ? null
        : read(before.blob, join(objects, before.blob))
      : Buffer.alloc(0);
    const next = after
      ? after.mode === 'symlink' || after.mode === 'gitlink'
        ? null
        : read(after.blob, join(captured, after.blob))
      : Buffer.alloc(0);
    const a = old && text(old),
      b = next && text(next);
    if (a === null || b === null) {
      // Not representable as text: keep the exact edited bytes (or note the deletion).
      if (after) {
        const target = join(copies, path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(join(captured, after.blob), target);
      }
      copied.push(after ? `${path} (${after.mode})` : `${path} (deleted)`);
      continue;
    }
    const header = [`diff --git a/${path} b/${path}`];
    if (!before) header.push(`new file mode ${modes[after!.mode]}`);
    else if (!after) header.push(`deleted file mode ${modes[before.mode]}`);
    else if (before.mode !== after.mode)
      header.push(`old mode ${modes[before.mode]}`, `new mode ${modes[after.mode]}`);
    if (a === b) {
      blocks.push(header.join('\n'));
      continue;
    }
    const removed = lines(a, '-'),
      added = lines(b, '+'),
      count = (value: string) => (value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0);
    blocks.push(
      [
        ...header,
        `--- ${before ? `a/${path}` : '/dev/null'}`,
        `+++ ${after ? `b/${path}` : '/dev/null'}`,
        `@@ -${count(a) ? 1 : 0},${count(a)} +${count(b) ? 1 : 0},${count(b)} @@`,
        ...removed,
        ...added,
      ].join('\n'),
    );
  }
  const notes = [
    `# Unsaved edits kept by Forge before abandoning Lane ${capture.marker.selection.laneId}`,
    `# Base head ${capture.marker.selection.head}. Re-apply in a fresh Lane: patch -p1 < '${patch}'`,
    ...(copied.length ? [`# Not in this patch (exact copies in ${copies}/): ${copied.join(', ')}`] : []),
  ];
  durableReplace(patch, `${[...notes, ...blocks].join('\n')}\n`);
  return {
    patch,
    files: capture.changes.length,
    ...(copied.length ? { copies, copied } : {}),
    apply: `patch -p1 < '${patch}'`,
  };
}
