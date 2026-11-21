// SPDX-License-Identifier: Apache-2.0
export const lifecycleVerbs: readonly ['start', 'save', 'land'];
export const promotedVerbs: readonly ['abandon', 'revert', 'cancel'];
export const coreVerbs: readonly [...typeof lifecycleVerbs, ...typeof promotedVerbs];
export const landSaveForm: 'land --save';
