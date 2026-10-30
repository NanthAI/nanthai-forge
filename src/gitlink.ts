// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';

/** A gitlink object stores only its pinned commit, never submodule source bytes.
 * A terminating newline is allowed when a person edits the pointer in a Lane. */
export function gitlinkCommit(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  invariant(
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?\n?$/.test(text),
    'INVALID_GITLINK',
    'A submodule pointer must contain its full pinned commit SHA.',
  );
  return text.trimEnd();
}

/** Read inert Git config data; includes, commands and URLs are never followed. */
export function gitmoduleUrls(text: string): Map<string, string> {
  const urls = new Map<string, string>();
  let section: { path?: string; url?: string } | null = null;
  const finish = () => {
    if (section?.path && section.url) urls.set(section.path, section.url);
  };
  for (const line of text.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
    const heading = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line);
    if (heading) {
      finish();
      section = /^submodule\s+"(?:[^"\\]|\\.)*"$/i.test(heading[1]!) ? {} : null;
      continue;
    }
    const field = /^\s*(path|url)\s*=\s*(.*)$/i.exec(line);
    if (!section || !field) continue;
    let value = '',
      quoted = false;
    const raw = field[2]!;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      if (c === '"') quoted = !quoted;
      else if (c === '\\' && i + 1 < raw.length) {
        const escaped = raw[++i]!;
        value += ({ n: '\n', t: '\t', b: '\b' } as Record<string, string>)[escaped] ?? escaped;
      } else if (!quoted && (c === '#' || c === ';')) break;
      else value += c;
    }
    if (!quoted) section[field[1]!.toLowerCase() as 'path' | 'url'] = value.trim();
  }
  finish();
  return urls;
}
export type SubmodulePointer = { path: string; commit: string; url: string | null };
export const submoduleLabel = (pointer: SubmodulePointer) =>
  `submodule → ${pointer.url ?? '(URL unavailable)'} @ ${pointer.commit.slice(0, 8)}`;

/** One metadata read and bounded object windows, with no per-pointer RPC. */
export async function readSubmodulePointers(
  files: readonly NativeFile[],
  read: (ids: string[]) => Promise<Uint8Array[]>,
  path?: string,
): Promise<SubmodulePointer[]> {
  const links = files.filter(file => file.mode === 'gitlink' && (path === undefined || file.path === path));
  if (!links.length) return [];
  const modules = files.find(
    file => file.path === '.gitmodules' && ['file', 'executable'].includes(file.mode),
  );
  const urls = modules
    ? gitmoduleUrls(new TextDecoder().decode((await read([modules.blob]))[0]))
    : new Map<string, string>();
  const pointers: SubmodulePointer[] = [];
  for (let at = 0; at < links.length; at += 100) {
    const window = links.slice(at, at + 100),
      bytes = await read(window.map(file => file.blob));
    invariant(
      bytes.length === window.length,
      'SOURCE_UNAVAILABLE',
      'Submodule pointer window is incomplete.',
    );
    pointers.push(
      ...window.map((file, i) => ({
        path: file.path,
        commit: gitlinkCommit(bytes[i]!),
        url: urls.get(file.path) ?? null,
      })),
    );
  }
  return pointers;
}
