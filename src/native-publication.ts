// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource, type NativeState } from './native-source.js';
import { ownerDerivedSchema } from './owner-derived.js';
import { archiveChannels } from './work-archive-metadata.js';
import { parseWorkBytes } from './work-metadata.js';
import { digest } from './hash.js';
import type { WorkStore } from './work-store.js';
import type { ExchangeManifest, ContentPin } from './native-exchange.js';
import type { PublicationMetadata } from './publication-metadata.js';

/** Parent edges already retain their complete source history. Omit blob edges
 * inherited from an immediate parent: the transitive closure is identical,
 * without resending every unchanged file for every retained State. */
export function publicationClosure(
  heads: readonly string[],
  read: (head: string) => Pick<NativeState, 'parents' | 'files' | 'git'>,
) {
  const recent = new Map<string, { parents: string[]; blobs: string[] }>();
  const state = (head: string) => {
    let value = recent.get(head);
    if (!value) {
      const source = read(head);
      value = {
        parents: source.parents,
        blobs: [
          ...new Set([...source.files.map(file => file.blob), ...(source.git ? [source.git.bundle] : [])]),
        ],
      };
      recent.set(head, value);
      if (recent.size > 8) recent.delete(recent.keys().next().value!);
    }
    return value;
  };
  return heads.map(head => {
    const current = state(head),
      inherited = new Set(current.parents.flatMap(parent => state(parent).blobs));
    return { head, parents: current.parents, blobs: current.blobs.filter(blob => !inherited.has(blob)) };
  });
}

/** Read only the already-pinned local snapshot; no hosted byte reads. */
export function nativePublicationMetadata(
  store: WorkStore,
  directory: string,
  manifest: ExchangeManifest,
  pins: ContentPin[],
  derived: Buffer,
): PublicationMetadata {
  const data = parseWorkBytes(readFileSync(join(directory, 'work.json'))),
    source = new NativeSource(store.root),
    states: string[] = JSON.parse(readFileSync(join(directory, 'states.json'), 'utf8'));
  return {
    schema: 1,
    work: readFileSync(join(directory, 'work.json'), 'utf8'),
    manifest,
    pins: pins.map(({ sha256, size }) => ({ sha256, size })),
    preview: {
      manifestDigest: digest(JSON.stringify(manifest)),
      head: manifest.head,
      format: 'native',
      revision: manifest.revision,
      intents: data.intents.length,
      lanes: data.lanes.length,
      views: data.views.length,
      runs: data.runs.length,
      files: manifest.files.length,
      unavailable: manifest.unavailable.length,
      channels: archiveChannels(manifest, data),
    },
    edges: publicationClosure(states, head => source.state(head)),
    ownerDerived: ownerDerivedSchema.parse(JSON.parse(derived.toString('utf8'))),
  };
}
