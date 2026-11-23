// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const lifecycleVerbs: readonly ['start', 'save', 'land'];
export const promotedVerbs: readonly ['abandon', 'revert', 'cancel'];
export const coreVerbs: readonly [...typeof lifecycleVerbs, ...typeof promotedVerbs];
export const landSaveForm: 'land --save';
