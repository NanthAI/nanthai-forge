// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Common credential syntax. Shared by the output redactor (masks them) and the board post
 * scanner (src/board-text.ts, rejects them). No Node globals: Convex V8 imports it. */
export const CREDENTIAL_PREFIXES: readonly string[] = [
  'Bearer ',
  'bearer ',
  'Basic ',
  'token=',
  'password=',
  'secret=',
  'api_key=',
  'apiKey=',
  'authorization=',
  'ghp_',
  'gho_',
  'github_pat_',
  'sk-',
];
/** Prefixes that count only at a token boundary (after space, quote, '=', ':' or a bracket). */
export const BOUNDARY_CREDENTIAL_PREFIXES: readonly string[] = [
  'Bearer ',
  'bearer ',
  'Basic ',
  'ghp_',
  'gho_',
  'github_pat_',
  'sk-',
];
