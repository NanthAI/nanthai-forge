// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** FORGE_QUEUE_KEEP_THE_RUN=1 wires the keep rule (Item fa2c1383) into the main-move sweep. Off by
 * default; deleted once the dogfood read decides. */
export const keepTheRunOn = () => process.env.FORGE_QUEUE_KEEP_THE_RUN === '1';
