// SPDX-License-Identifier: Apache-2.0
export const localeEnvNames: readonly string[];
export function childEnv(options?: {
  allow?: readonly string[];
  extra?: NodeJS.ProcessEnv;
  source?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Record<string, string>;
export const toolchainEnvNames: readonly string[];
export const toolchainEnvPattern: RegExp;
export function toolchainEnvAllow(source?: NodeJS.ProcessEnv): string[];
