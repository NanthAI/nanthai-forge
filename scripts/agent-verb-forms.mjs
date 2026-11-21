// SPDX-License-Identifier: Apache-2.0
/** Public lifecycle forms shared by CLI dispatch and static agent-document generation. */
export const lifecycleVerbs = Object.freeze(['start', 'save', 'land']);
export const promotedVerbs = Object.freeze(['abandon', 'revert', 'cancel']);
export const coreVerbs = Object.freeze([...lifecycleVerbs, ...promotedVerbs]);
export const landSaveForm = 'land --save';
