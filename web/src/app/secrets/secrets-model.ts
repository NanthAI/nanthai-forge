// SPDX-License-Identifier: Apache-2.0
// Metadata only. The gated device protocol will supply this view; neither values, ciphertext nor key material
// belong in it. Totals describe the complete set; arrays are one bounded page, never a whole collection read.
export type SecretName = {
  name: string;
  changed: string;
  by?: string;
  note?: string;
  state?: 'rotate' | 'through-checks' | 'missing';
};
export type SecretHolder = {
  id: string;
  kind: 'person' | 'machine';
  label: string;
  detail: string;
  canRemove?: boolean;
};
export type SecretSet = {
  id: 'development' | 'checks';
  names: readonly SecretName[];
  nameTotal: number;
  holders: readonly SecretHolder[];
  holderTotal: number;
};
export type SecretsMetadata = {
  sets: readonly SecretSet[];
  rotationTotal: number;
  missingTotal: number;
  waiting: readonly { id: string; handle: string; code: string; set: 'development' | 'checks' }[];
  waitingTotal: number;
  sharing: 'automatic' | 'confirm';
  canManageSharing?: boolean;
  recent: readonly { id: string; when: string; text: string; automatic?: boolean }[];
  // This is supplied only for the agreed lone-holder/non-reissuable case, not inferred from holder counts.
  recovery?: 'non-reissuable-without-envelope';
};
export type SecretsView =
  | { status: 'unavailable' | 'loading' | 'forbidden' }
  | { status: 'ready'; metadata: SecretsMetadata }
  | { status: 'failed'; previous?: SecretsMetadata; lastShown?: string };

/** A local stub, not a backend fallback. No query, storage, timer or invented project data. */
export function secretsView(): SecretsView {
  return { status: 'unavailable' };
}

export const secretSetLabel = (id: SecretSet['id']) => (id === 'development' ? 'Development' : 'Checks');
export const secretCount = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const secretPageCount = (shown: number, total: number, noun: string) =>
  shown < total ? `${shown.toLocaleString()} of ${secretCount(total, noun)}` : secretCount(total, noun);

/** Commands are proposals until the protocol lands. Quote metadata as a single shell argument; never run it. */
export function secretSetCommand(name: string, set: SecretSet['id']) {
  const argument = /^[A-Z_][A-Z0-9_]*$/.test(name) ? name : `'${name.replaceAll("'", "'\\''")}'`;
  return `nforge secret set ${argument}${set === 'checks' ? ' --set checks' : ''}`;
}
