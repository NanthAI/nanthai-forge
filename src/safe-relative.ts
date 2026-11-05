// SPDX-License-Identifier: Apache-2.0
// An empty, '.' or '..' segment: at the start or after a separator, ending at a separator or the end.
const unsafeSegment = /(?:^|\/)\.{0,2}(?=\/|$)/;
export function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !/[\r\n]/.test(path) &&
    !unsafeSegment.test(path)
  );
}
