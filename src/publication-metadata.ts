// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ExchangeManifest, ContentPin } from './native-exchange.js';
import type { OwnerDerived } from './owner-derived.js';
export const METADATA_PUBLICATION = 'metadata-publication-v1' as const;
export const PUBLICATION_PAGE_BYTES = 128 * 1024;
export const publicationHash = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)));
export const publicationChain = (previous: string, page: string) =>
  publicationHash(JSON.stringify([previous, page]));
export type PublicationMetadata = {
  schema: 1;
  manifest: ExchangeManifest;
  preview: {
    manifestDigest: string;
    head: string;
    format: 'native';
    revision: number;
    intents: number;
    lanes: number;
    views: number;
    runs: number;
    files: number;
    unavailable: number;
    channels: { name: string; head: string }[];
  };
  pins: ContentPin[];
  /** Blob edges inherited through parent States are omitted; closure remains complete. */
  edges: { head: string; parents: string[]; blobs: string[] }[];
  ownerDerived: OwnerDerived;
};
/** Split text, not encoded bytes, so each JSON argument is valid Unicode. Even
 * all control characters fit the per-page encoded budget after JSON escaping. */
export function publicationPages(value: PublicationMetadata) {
  const json = JSON.stringify(value),
    pages: string[] = [];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + 16 * 1024, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1]!)) end--;
    pages.push(json.slice(offset, end));
    offset = end;
  }
  return { pages, digest: publicationHash(json) };
}
