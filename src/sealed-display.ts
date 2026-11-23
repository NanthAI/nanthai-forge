// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Terminal output is derived from verified names, with control/escape bytes removed. */
export const safeSecretName = (name: string) => name.replace(/[^A-Z0-9_]/g, '?').slice(0, 64);
