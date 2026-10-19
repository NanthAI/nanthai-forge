// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { digest } from './hash.js';
export function sourceFilePage(bytes: Buffer, file: string, line = 1) {
  invariant(Number.isSafeInteger(line) && line > 0, 'BAD_ARGUMENT', 'Choose a positive line number.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invariant(false, 'SOURCE_UNAVAILABLE', 'This file is not UTF-8 text.');
  }
  const lines = text.split('\n');
  invariant(line <= lines.length, 'BAD_ARGUMENT', 'Line is beyond this file.');
  const endLine = Math.min(lines.length, line + 79);
  return {
    file,
    digest: digest(bytes),
    text: lines.slice(line - 1, endLine).join('\n'),
    startLine: line,
    endLine,
    totalLines: lines.length,
  };
}
