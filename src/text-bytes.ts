// SPDX-License-Identifier: Apache-2.0
/** Text versus binary the way Git decides it (Issue 113bc7b3): no NUL byte in the first
 * 8,000 bytes and no UTF-16 byte-order mark (a UTF-32 mark holds a NUL). UTF-8 validity
 * does not decide it: Windows-1252, Latin-1 and other ASCII-compatible encodings are text
 * and merge and diff line by line on their bytes. Pure: also runs in the Convex runtime. */
export const TEXT_SNIFF_BYTES = 8000;
export function isTextBytes(bytes: Uint8Array) {
  if (bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0)) return false;
  return !(
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** The exact UTF-8 text, or null when the bytes are not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}
/** Line text for display, lossless for any bytes: valid UTF-8 as is; otherwise each byte
 * that is not part of valid UTF-8 shows as \xNN and a backslash shows as \\, and the line
 * is marked escaped. */
export function displayLine(bytes: Uint8Array): { text: string; escaped?: true } {
  const text = utf8Text(bytes);
  if (text !== null) return { text };
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i]!,
      length = byte < 0x80 ? 1 : byte < 0xc2 ? 0 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : byte < 0xf5 ? 4 : 0;
    const char = length && i + length <= bytes.length ? utf8Text(bytes.subarray(i, i + length)) : null;
    if (char !== null) {
      out += char === '\\' ? '\\\\' : char;
      i += length;
    } else {
      out += `\\x${byte.toString(16).padStart(2, '0')}`;
      i++;
    }
  }
  return { text: out, escaped: true };
}
/** The line ending for synthesised lines (conflict markers, a terminated last line), from
 * the given lines (Issue d36380ca): CRLF only when every terminated line ends in CRLF; LF
 * when they are mixed; null when no line is terminated. */
export function linesEol(lines: readonly string[]): '\n' | '\r\n' | null {
  let crlf = 0,
    lf = 0;
  for (const line of lines)
    if (line.endsWith('\r\n')) crlf++;
    else if (line.endsWith('\n')) lf++;
  return crlf && !lf ? '\r\n' : crlf || lf ? '\n' : null;
}
/** One character per byte (code points 0-255), exact both ways and runtime-neutral (no
 * Buffer; the WHATWG "latin1" decoder is Windows-1252 and is not byte-exact). */
export function byteString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 8192)));
  return out;
}
export function stringBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
