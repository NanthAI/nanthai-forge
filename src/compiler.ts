// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';
import type { Tree } from '@lezer/common';
import { posix } from 'node:path';
import { sourceLanguage } from './languages.js';
import type { Snapshot } from './types.js';

const prefix = '/forge/';
export const virtual = (path: string): string => `${prefix}${path}`;
export const local = (path: string): string => path.slice(prefix.length);

export function resolveImport(from: string, specifier: string, content: Map<string, string>): string | null {
  if (!specifier.startsWith('.') || specifier.includes('\\')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base.startsWith('../') || base === '..' || posix.isAbsolute(base)) return null;
  const replacement = base.replace(/\.(js|jsx|mjs|cjs)$/, (_all, extension: string) => {
    return { js: '.ts', jsx: '.tsx', mjs: '.mts', cjs: '.cts' }[extension] ?? '.ts';
  });
  const candidates = [
    replacement,
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.d.ts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.d.ts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return (
    candidates.find(
      path => content.has(path) && ['typescript', 'javascript'].includes(sourceLanguage(path) ?? ''),
    ) ?? null
  );
}

/** Owned by one indexing worker/session; never a process-wide repository cache. */
export type CompilerSession = {
  root?: string;
  program?: ts.Program;
  parsedFiles?: number;
  reusedFiles?: number;
  structuralRoot?: string;
  structuralTrees?: Map<string, { text: string; tree: Tree }>;
};
export function makeProgram(snapshot: Snapshot, session?: CompilerSession): ts.Program {
  const previous = session?.root === snapshot.root ? session.program : undefined;
  let parsedFiles = 0,
    reusedFiles = 0;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
    allowImportingTsExtensions: true,
    allowJs: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion, _onError, shouldCreateNewSourceFile) => {
      const text = snapshot.content.get(local(name));
      if (text === undefined) return undefined;
      const retained = !shouldCreateNewSourceFile ? previous?.getSourceFile(name) : undefined;
      if (retained?.text === text) {
        reusedFiles++;
        return retained;
      }
      parsedFiles++;
      return ts.createSourceFile(name, text, languageVersion, true);
    },
    getDefaultLibFileName: () => '/unavailable-lib.d.ts',
    writeFile: () => {
      throw new Error('Forge never emits source');
    },
    getCurrentDirectory: () => '/forge',
    getDirectories: () => [],
    fileExists: name => snapshot.content.has(local(name)),
    readFile: name => snapshot.content.get(local(name)),
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNames: (names, containing) =>
      names.map(name => {
        const found = resolveImport(local(containing), name, snapshot.content);
        if (!found) return undefined;
        const extension = found.endsWith('.tsx')
          ? ts.Extension.Tsx
          : found.endsWith('.mts')
            ? ts.Extension.Mts
            : found.endsWith('.cts')
              ? ts.Extension.Cts
              : found.endsWith('.d.ts')
                ? ts.Extension.Dts
                : found.endsWith('.jsx')
                  ? ts.Extension.Jsx
                  : found.endsWith('.mjs')
                    ? ts.Extension.Mjs
                    : found.endsWith('.cjs')
                      ? ts.Extension.Cjs
                      : found.endsWith('.js')
                        ? ts.Extension.Js
                        : ts.Extension.Ts;
        return { resolvedFileName: virtual(found), extension };
      }),
  };
  const program = ts.createProgram(
    [...snapshot.content.keys()]
      .filter(path => ['typescript', 'javascript'].includes(sourceLanguage(path) ?? ''))
      .map(virtual),
    options,
    host,
    previous,
  );
  if (session) {
    session.root = snapshot.root;
    session.program = program;
    session.parsedFiles = parsedFiles;
    session.reusedFiles = reusedFiles;
  }
  return program;
}
