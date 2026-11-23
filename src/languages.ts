// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The analysed languages and their file extensions, from the ecosystem registry (src/ecosystems.ts).
import { codeMapLanguages, type SourceLanguage } from './ecosystems.js';
export type { SourceLanguage } from './ecosystems.js';
const EXTENSIONS: [RegExp, SourceLanguage][] = codeMapLanguages();
export function sourceLanguage(path: string): SourceLanguage | undefined {
  return EXTENSIONS.find(([pattern]) => pattern.test(path))?.[1];
}
/** Build manifests the analysers read to resolve imports (Go module path). They are captured
 * with the source but are not parsed as code. */
export const analysisManifest = (path: string): boolean => /(^|\/)go\.mod$/.test(path);
