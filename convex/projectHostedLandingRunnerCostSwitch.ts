// SPDX-License-Identifier: Apache-2.0
/** Readers accept both forms before this switch can emit the compact form. */
export const compactDiscardedChecksOn = () => process.env.FORGE_COMPACT_DISCARDED_CHECKS === '1';
