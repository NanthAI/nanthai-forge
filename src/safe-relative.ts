// SPDX-License-Identifier: Apache-2.0
// Win32 filesystem aliases must stay unsafe when source first passes through a POSIX host.
const windowsAlias =
  /(?:^|\/)(?:[^/]*[ .]|[^/]*:[^/]*|\.?(?:git|forge)~\d+(?:\.[^/]*)?|(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.[^/]*)?)(?=\/|$)/i;
// An empty, '.' or '..' segment, at the start or after a separator.
const unsafeSegment = /(?:^|\/)\.{0,2}(?=\/|$)/;
export function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !/[\r\n]/.test(path) &&
    !unsafeSegment.test(path) &&
    !windowsAlias.test(path)
  );
}
