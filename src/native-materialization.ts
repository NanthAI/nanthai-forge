// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { NativeWorkspaceFiles } from './native-workspace-files.js';

/** One private restore owns this reader. Every miss uses the authoritative
 * digest-bound reader; validated buffers survive only this materialization pass.
 * Eviction affects work, never supported content size or retained history. */
export class NativeMaterialization extends NativeSource {
  private readonly verified = new Map<string, Buffer>();
  private retainedBytes = 0;
  private workspaceFiles: NativeWorkspaceFiles | undefined;
  constructor(
    owner: string,
    private readonly byteBudget = 32 * 1024 * 1024,
  ) {
    super(owner);
  }
  protected override withMaterialization<T>(action: (files: NativeWorkspaceFiles) => T): T {
    this.workspaceFiles ??= new NativeWorkspaceFiles(
      this.directory,
      id => this.readVerified(id, false),
      true,
    );
    return action(this.workspaceFiles);
  }
  dispose() {
    this.workspaceFiles?.dispose();
    this.workspaceFiles = undefined;
    this.verified.clear();
    this.retainedBytes = 0;
  }
  override object(id: string): Buffer {
    return this.readVerified(id, true);
  }
  private readVerified(id: string, copy: boolean): Buffer {
    const retained = this.verified.get(id);
    if (retained) {
      this.verified.delete(id);
      this.verified.set(id, retained);
      return copy ? Buffer.from(retained) : retained;
    }
    const bytes = super.object(id);
    if (bytes.length > this.byteBudget) return bytes;
    {
      while (this.retainedBytes + bytes.length > this.byteBudget) {
        const first = this.verified.keys().next().value!;
        this.retainedBytes -= this.verified.get(first)!.length;
        this.verified.delete(first);
      }
      this.verified.set(id, bytes);
      this.retainedBytes += bytes.length;
    }
    return copy ? Buffer.from(bytes) : bytes;
  }
}
