// SPDX-License-Identifier: Apache-2.0
export function browserInstallEnv(
  home: string,
  cache: string,
  source?: Record<string, string | undefined>,
): Record<string, string>;
export function installBrowser(version: string, cache: string, options?: { timeout?: number }): void;
