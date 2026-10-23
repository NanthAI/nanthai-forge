// SPDX-License-Identifier: Apache-2.0
/** Existing repository notices plus Markdown documents; never a filesystem or network authority. */
export function isRepositoryNotice(path: string): boolean {
  return /^(readme\.md|(commercial[_-])?licen[sc]e([.-].*)?|copying([.-].*)?|notice([.-].*)?)$/i.test(
    path.split('/').at(-1) ?? '',
  );
}
export function isRepositoryDocument(path: string): boolean {
  return /\.(md|markdown)$/i.test(path) || isRepositoryNotice(path);
}
export type DocumentTarget = { file: string; anchor: string; source: boolean; line: number };
export function documentTarget(href: string, from: string): DocumentTarget | null {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
  try {
    const [address = '', ...fragment] = href.split('#'),
      path = decodeURIComponent(address.split('?')[0] ?? '');
    const anchor = decodeURIComponent(fragment.join('#'));
    if (path.startsWith('//') || /[\\\0\r\n]/.test(path) || /[\0\r\n]/.test(anchor)) return null;
    const parts = path.startsWith('/') ? [] : from.split('/').slice(0, -1);
    if (!path) parts.push(from.split('/').at(-1) ?? '');
    else
      for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
          if (!parts.length) return null;
          parts.pop();
        } else parts.push(part);
      }
    const file = parts.join('/'),
      source = /\.(ts|tsx|mts|cts)$/.test(file);
    if (!file || (!source && !isRepositoryDocument(file))) return null;
    const line = source && /^L\d+(?:-L?\d+)?$/.test(anchor) ? Number(anchor.match(/^L(\d+)/)![1]) : 1;
    return { file, anchor, source, line: Number.isSafeInteger(line) && line > 0 ? line : 1 };
  } catch {
    return null;
  }
}
