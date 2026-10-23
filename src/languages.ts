// SPDX-License-Identifier: Apache-2.0
export type SourceLanguage = 'typescript' | 'javascript' | 'python' | 'java' | 'rust';
export function sourceLanguage(path: string): SourceLanguage | undefined {
  if (/\.(ts|tsx|mts|cts)$/.test(path)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return 'javascript';
  if (/\.py$/.test(path)) return 'python';
  if (/\.java$/.test(path)) return 'java';
  if (/\.rs$/.test(path)) return 'rust';
  return undefined;
}
