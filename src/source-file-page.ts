// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { sourceFilePageText } from './source-file-page-core.js';
export function sourceFilePage(bytes: Buffer, file: string, line = 1) {
  return sourceFilePageText(bytes, file, line, digest(bytes));
}
