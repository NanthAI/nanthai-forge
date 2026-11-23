// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Readers accept both forms before this switch can emit the compact form. */
export const compactDiscardedChecksOn = () => process.env.FORGE_COMPACT_DISCARDED_CHECKS === '1';
