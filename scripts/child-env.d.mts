// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
export const runnerEnvNames: Readonly<Record<'github-actions', readonly string[]>>;
export function runnerEnvAllow(source?: NodeJS.ProcessEnv): string[];
