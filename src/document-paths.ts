// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Existing repository notices plus Markdown documents; never a filesystem or network authority. */
export function isRepositoryNotice(path: string): boolean {
  return /^(readme\.md|(commercial[_-])?licen[sc]e([.-].*)?|copying([.-].*)?|notice([.-].*)?)$/i.test(
    path.split('/').at(-1) ?? '',
  );
}
export function isRepositoryDocument(path: string): boolean {
  return /\.(md|markdown)$/i.test(path) || isRepositoryNotice(path);
}
