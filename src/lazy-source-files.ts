// SPDX-License-Identifier: Apache-2.0

/** A path -> text map that holds only paths and blob ids; text is read (and dropped) per `get`.
 * Selection readers touch a few files, so memory stays flat on a 100k-file tree and binaries
 * are never decoded unless a reader asks for them. */
export class LazySourceFiles extends Map<string, string> {
  constructor(
    private blobs: ReadonlyMap<string, string>,
    private read: (blob: string) => string,
  ) {
    super([...blobs.keys()].map(path => [path, '']));
  }
  override get(path: string) {
    const blob = this.blobs.get(path);
    return blob ? this.read(blob) : undefined;
  }
  override *entries(): MapIterator<[string, string]> {
    for (const path of this.keys()) yield [path, this.get(path)!];
  }
  override [Symbol.iterator]() {
    return this.entries();
  }
  override *values(): MapIterator<string> {
    for (const path of this.keys()) yield this.get(path)!;
  }
  override forEach(
    callback: (value: string, key: string, map: Map<string, string>) => void,
    thisArg?: unknown,
  ) {
    for (const [path, text] of this.entries()) callback.call(thisArg, text, path, this);
  }
}
