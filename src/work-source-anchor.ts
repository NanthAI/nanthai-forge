// SPDX-License-Identifier: Apache-2.0
import type { SourceAnchor } from './work-intent-types.js';
import type { WorkData } from './work-types.js';
import type { NativeFile } from './native-source.js';
import { invariant } from './errors.js';
import { digest } from './portable-hash.js';

export function validateAnchorView(
  view: WorkData['views'][number] | undefined,
  intentId: string,
  anchor: SourceAnchor,
) {
  invariant(
    view?.intentId === intentId &&
      view.status === 'clean' &&
      view.base === anchor.base &&
      view.head === anchor.head,
    'SOURCE_CHANGED',
    'Choose a line in an exact View for this Intent. Your comment remains available.',
  );
}
export function validateAnchorFile(
  anchor: SourceAnchor,
  file: NativeFile | undefined,
  bytes: Buffer | undefined,
) {
  invariant(
    file?.path === anchor.file && file.blob === anchor.blob && bytes && digest(bytes) === anchor.blob,
    'SOURCE_CHANGED',
    'This file differs from the selected source. Your comment remains available.',
  );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Choose a line in a UTF-8 source file.');
  }
  invariant(
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) && anchor.line <= text.split('\n').length,
    'BAD_ARGUMENT',
    'Choose a line present in this exact source file.',
  );
}
