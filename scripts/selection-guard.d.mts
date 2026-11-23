// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
type Selection = { scope: string; reason: string; tests: string[] };
export class ZeroSelectionError extends Error {
  readonly code: 'ZERO_SELECTION';
}
export function guardSelection<T extends Selection>(
  selection: T,
  input: {
    files: Map<string, string>;
    paths?: string[] | null | undefined;
    interaction?: unknown;
    documentation: (path: string) => boolean;
    smoke: string[];
  },
): T;
export function assertRunnableSelection(
  selection: { scope?: string } | null | undefined,
  files: string[],
  staticJob?: boolean,
): void;
