// SPDX-License-Identifier: Apache-2.0
export type IndexHeader = {
  payload?: boolean;
  payloadKey?: string;
  payloadParts?: number;
  status?: string;
  noteCount?: number;
  lifecycleCount?: number;
  localObservation?: boolean;
};
export function assembleIndexValue<T>(
  collection: string,
  header: T & IndexHeader,
  parts: { position: number; value: string }[],
  options: { overlayLocalObservation?: boolean; incomplete?: () => never } = {},
): T {
  if (!header.payloadKey) return header;
  if (parts.length !== header.payloadParts || parts.some((part, index) => part.position !== index)) {
    if (options.incomplete) return options.incomplete();
    throw new Error('The selected Work record is still incomplete. Its original content remains retained.');
  }
  const original = JSON.parse(parts.map(part => part.value).join('')) as T;
  if (collection !== 'intents')
    return options.overlayLocalObservation && header.localObservation ? { ...original, ...header } : original;
  // Intent status and history counts can advance without rewriting its immutable attributes.
  return {
    ...original,
    status: header.status,
    notes: [],
    ...(header.noteCount === undefined ? {} : { noteCount: header.noteCount }),
    ...(header.lifecycleCount === undefined ? {} : { lifecycle: [], lifecycleCount: header.lifecycleCount }),
  };
}
