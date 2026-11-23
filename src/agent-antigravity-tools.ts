// SPDX-License-Identifier: Apache-2.0
// Shared by the Antigravity hook entry and its installer, so the CLI bundle never imports the hook.

/** Antigravity file-writing tools (names are lowercased step types). */
export const ANTIGRAVITY_EDIT_TOOLS = [
  'write_file',
  'write_to_file',
  'create_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'delete_file',
  'edit_notebook',
  'apply_patch',
] as const;
