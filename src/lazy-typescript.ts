// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import type TypeScript from 'typescript';

let loaded: typeof TypeScript | undefined;
/** The TypeScript compiler (about 9 MB of JavaScript) loads on first use, never when a module that
 * may parse source is imported: every CLI command would otherwise pay its load at start. Callers
 * keep `import type ts from 'typescript'` for types and bind `const ts = loadTypescript()` where
 * they parse. */
export function loadTypescript(): typeof TypeScript {
  return (loaded ??= createRequire(import.meta.url)('typescript') as typeof TypeScript);
}
