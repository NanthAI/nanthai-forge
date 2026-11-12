// SPDX-License-Identifier: Apache-2.0
/** Internal metadata window; byte transfers retain their separate 16 MiB window. */
export const hostedDownloadPageSize = 500;
export type HostedDownloadDescriptor = {
  digest: string;
  size: number;
  sourceVersion?: 2;
  statePhysical?: { sha256: string; size: number };
  url?: string;
  closure?: import('./blob-download-format.js').SignedDownload[];
  range?: import('./object-pack-range.js').PackRange;
};
