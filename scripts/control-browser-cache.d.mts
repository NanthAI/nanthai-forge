// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export function browserInstallEnv(
  home: string,
  cache: string,
  source?: Record<string, string | undefined>,
): Record<string, string>;
export function installBrowser(version: string, cache: string, options?: { timeout?: number }): void;
