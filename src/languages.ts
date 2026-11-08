// SPDX-License-Identifier: Apache-2.0
// The one place that names the analysed languages and their file extensions.
export type SourceLanguage = 'typescript' | 'javascript' | 'python' | 'java' | 'rust' | 'go' | 'csharp';
const EXTENSIONS: [RegExp, SourceLanguage][] = [
  [/\.(ts|tsx|mts|cts)$/, 'typescript'],
  [/\.(js|jsx|mjs|cjs)$/, 'javascript'],
  [/\.py$/, 'python'],
  [/\.java$/, 'java'],
  [/\.rs$/, 'rust'],
  [/\.go$/, 'go'],
  [/\.cs$/, 'csharp'],
];
export function sourceLanguage(path: string): SourceLanguage | undefined {
  return EXTENSIONS.find(([pattern]) => pattern.test(path))?.[1];
}
/** Build manifests the analysers read to resolve imports (Go module path). They are captured
 * with the source but are not parsed as code. */
export const analysisManifest = (path: string): boolean => /(^|\/)go\.mod$/.test(path);
