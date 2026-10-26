// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { prepareNativeObjects, preparedCheckpointCurrent } from './native-checkpoint-publication.js';
import { PreparationChanged } from './work-edit.js';

/** Reuse checkpoint publication's byte preparation and final metadata CAS for
 * new composition/fast-path objects. Collection can never leave dangling refs. */
export class PreparedWorkSource extends NativeSource {
  private readonly objects = new Map<string, Buffer>();
  override put(bytes: Buffer) {
    const id = super.put(bytes);
    this.objects.set(id, bytes);
    return id;
  }
  preparePublication() {
    const prepared = prepareNativeObjects(new NativeSource(this.owner), this.objects);
    return () => {
      try {
        preparedCheckpointCurrent(this, prepared);
      } catch {
        throw new PreparationChanged(
          'Prepared source changed. Retry the original operation; nothing was overwritten.',
        );
      }
    };
  }
}
