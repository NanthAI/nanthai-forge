// SPDX-License-Identifier: Apache-2.0
/** Terminal output is derived from verified names, with control/escape bytes removed. */
export const safeSecretName = (name: string) => name.replace(/[^A-Z0-9_]/g, '?').slice(0, 64);
