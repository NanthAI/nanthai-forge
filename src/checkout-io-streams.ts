// SPDX-License-Identifier: Apache-2.0
import { createReadStream, createWriteStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { checkoutIo, checkoutIoActive } from './checkout-io.js';

/** Stream one bounded chunk per permit, leaving network and decompression free
 * to progress without reserving a volume worker between chunks. */
export function checkoutReadStream(path: string) {
  if (!checkoutIoActive()) return createReadStream(path);
  return Readable.from(
    (async function* () {
      const handle = await checkoutIo(() => open(path, 'r'), 'read');
      try {
        for (;;) {
          const bytes = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await checkoutIo(() => handle.read(bytes, 0, bytes.length, null), 'read');
          if (!bytesRead) break;
          yield bytes.subarray(0, bytesRead);
        }
      } finally {
        await checkoutIo(() => handle.close(), 'read');
      }
    })(),
  );
}
export function checkoutWriteStream(path: string) {
  if (!checkoutIoActive()) return createWriteStream(path, { mode: 0o600 });
  let handle: FileHandle | undefined;
  return new Writable({
    construct(done) {
      void checkoutIo(() => open(path, 'w', 0o600)).then(file => {
        handle = file;
        done();
      }, done);
    },
    write(bytes, _encoding, done) {
      void checkoutIo(() => handle!.writeFile(bytes)).then(() => done(), done);
    },
    destroy(error, done) {
      const file = handle;
      handle = undefined;
      if (file)
        void checkoutIo(() => file.close()).then(
          () => done(error),
          closeError => done(error ?? closeError),
        );
      else done(error);
    },
  });
}
