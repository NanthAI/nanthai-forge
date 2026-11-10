// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

const prefix = Buffer.from('{"schema":1,"kind":"forge-source-state","parents":[],"files":[');
const pathKey = Buffer.from('{"path":'),
  blobKey = Buffer.from(',"blob":"'),
  modeKey = Buffer.from('","mode":"');
const modes = new Map(['file', 'executable', 'symlink', 'gitlink'].map(mode => [mode, mode]));
const hex = /^[0-9a-f]{64}$/;

/** The files of a root import State, in order, read from its exact bytes one entry at a time.
 * Publication writes these bytes (JSON.stringify of each file); a retry rereads them without
 * parsing the whole State into one object per file. Anything else is not this State. */
export function* importStateFiles(bytes: Buffer): Generator<{ path: string; blob: string; mode: string }> {
  const fail = () =>
    invariant(false, 'INVALID_WORK_BACKUP', 'The stored State is not an import State.') as never;
  const expect = (at: number, token: Buffer) => {
    if (at + token.length > bytes.length || bytes.compare(token, 0, token.length, at, at + token.length))
      fail();
    return at + token.length;
  };
  let at = expect(0, prefix);
  if (bytes[at] === 0x5d) return;
  for (;;) {
    const start = expect(at, pathKey);
    // A JSON string: the first unescaped quote ends it.
    if (bytes[start] !== 0x22) fail();
    let end = start + 1;
    while (end < bytes.length && bytes[end] !== 0x22) end += bytes[end] === 0x5c ? 2 : 1;
    if (end >= bytes.length) fail();
    const path: unknown = JSON.parse(bytes.toString('utf8', start, end + 1));
    at = expect(end + 1, blobKey);
    const blob = bytes.toString('latin1', at, at + 64);
    at = expect(at + 64, modeKey);
    const close = bytes.indexOf(0x22, at);
    const mode = close < 0 ? undefined : modes.get(bytes.toString('latin1', at, close));
    if (typeof path !== 'string' || !hex.test(blob) || !mode || bytes[close + 1] !== 0x7d) fail();
    yield { path: path as string, blob, mode: mode! };
    at = close + 2;
    if (bytes[at] === 0x5d) return;
    if (bytes[at++] !== 0x2c) fail();
  }
}
