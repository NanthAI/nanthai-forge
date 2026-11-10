// SPDX-License-Identifier: Apache-2.0
// Tree fidelity of the zoo run (Issue 70a9bd2f): does a Forge clone hold the same files as a plain
// `git clone` of the same repository on the same machine? Compares path, kind (file, executable,
// symlink), size and symlink target, so CRLF, file modes, LFS pointers, large binaries, case-only
// renames and odd names are all checked by one generic rule, never per repository.
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';

// `.git` (a folder, or a file in a submodule) is never tracked content; `.forge` is Forge's own folder.
const SKIP = (dir, name) => name === '.git' || (!dir && name === '.forge');

/** Every entry below `root` as Map(path -> { kind, size, target }). A submodule folder that git left
 * empty is a directory and not listed; its contents (Forge materializes them) are listed. */
export function walkTree(root) {
  const out = new Map();
  // Names are read as bytes: a path that is not valid UTF-8 (git can write one on some volumes) cannot be
  // addressed through a decoded string. The map key is the bytes as Latin-1, so equal names give equal keys.
  const walk = (dir, bytes) => {
    for (const name of readdirSync(bytes, { encoding: 'buffer' })) {
      const key = name.toString('latin1');
      if (SKIP(dir, key)) continue;
      const rel = dir ? `${dir}/${key}` : key;
      const full = Buffer.concat([bytes, Buffer.from('/'), name]);
      const st = lstatSync(full);
      if (st.isSymbolicLink())
        out.set(rel, {
          kind: 'symlink',
          size: 0,
          target: readlinkSync(full, { encoding: 'buffer' }).toString('latin1'),
        });
      else if (st.isDirectory()) walk(rel, full);
      else out.set(rel, { kind: st.mode & 0o111 ? 'exec' : 'file', size: st.size, target: null });
    }
  };
  walk('', Buffer.from(root));
  return out;
}

/** A walkTree key as readable text (the bytes decoded as UTF-8, invalid ones replaced). */
export const keyText = key => Buffer.from(key, 'latin1').toString('utf8');

/** What differs between the Forge clone (`forge`) and the plain-git checkout (`git`), both Maps from
 * walkTree. `ignore(path)` skips paths the comparison must not judge (submodule folders).
 * Returns counts and up to `limit` example paths per class. */
export function compareTrees(git, forge, { ignore = () => false, limit = 5 } = {}) {
  const classes = { missing: [], extra: [], kind: [], size: [], target: [] };
  let compared = 0;
  for (const [path, want] of git) {
    if (ignore(path)) continue;
    compared++;
    const got = forge.get(path);
    if (!got) classes.missing.push(path);
    else if (got.kind !== want.kind) classes.kind.push(`${path} (${want.kind} -> ${got.kind})`);
    else if (want.kind === 'symlink' ? got.target !== want.target : got.size !== want.size)
      (want.kind === 'symlink' ? classes.target : classes.size).push(path);
  }
  for (const path of forge.keys()) if (!git.has(path) && !ignore(path)) classes.extra.push(path);
  const counts = Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.length]));
  return {
    ok: Object.values(counts).every(n => n === 0),
    compared,
    counts,
    examples: Object.fromEntries(
      Object.entries(classes).map(([k, v]) => [k, v.slice(0, limit).map(keyText)]),
    ),
  };
}

/** Paths git's own checkout could not materialize here (a platform limit, not a Forge fault):
 * entries of `git ls-tree -r -z` output with no counterpart in the checkout. */
export function platformLimits(lsTreeZ, checkout) {
  const missing = [];
  for (const record of String(lsTreeZ).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const mode = record.slice(0, record.indexOf(' '));
    const path = record.slice(tab + 1);
    if (mode === '160000') continue;
    if (!checkout.has(Buffer.from(path).toString('latin1'))) missing.push(path);
  }
  return missing;
}
