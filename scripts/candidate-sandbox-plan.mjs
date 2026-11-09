// SPDX-License-Identifier: Apache-2.0
// The Candidate sandbox's mount plan (scripts/candidate-sandbox.mjs), as plain data so it is testable
// without root. Plain Node only.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Private, Candidate-owned copies of toolchain state folders live here, one per folder and job. */
export const STATE_ROOT = '/var/lib/forge-check/state';
export const stateStore = path =>
  join(STATE_ROOT, createHash('sha256').update(path).digest('hex').slice(0, 16));
const inside = (path, root) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * Steps that build the Candidate's view, in order. The runner's home (`home`, bound at `real`) is
 * replaced by an empty Candidate-owned folder; then, parents first:
 * - `writable` (under the home): the real folder, bound writable (the Candidate's own);
 * - `readable` (under the home): the real folder, bound read-only, unless a read-only parent or a
 *   private copy already shows it;
 * - `copies` (any toolchain state folder): a private copy in STATE_ROOT, owned by the Candidate,
 *   bound writable at the original path. The original is only ever read.
 * Only folders this plan creates in the fresh home are chowned; an existing mount point never is (it
 * can sit inside a read-only bind). `exists`/`isDirectory` read the runner's real paths.
 */
export function mountPlan({ home, real, writable = [], readable = [], copies = [], exists, isDirectory }) {
  const steps = [];
  const homed = home !== '/' && exists(home);
  const under = path => homed && path.startsWith(`${home}/`);
  const toReal = path => (under(path) ? join(real, path.slice(home.length)) : path);
  const safeCopy = path =>
    path.startsWith('/') && path !== '/' && path !== home && !inside(home, path) && !inside(path, STATE_ROOT);
  const entries = [
    ...writable.filter(under).map(path => ({ path, kind: 'rw' })),
    ...readable.filter(under).map(path => ({ path, kind: 'ro' })),
    ...copies
      .filter(path => safeCopy(path) && (under(path) || !inside(path, home)))
      .map(path => ({ path, kind: 'copy' })),
  ].sort((a, b) => a.path.length - b.path.length);
  /** Mounted so far: path -> real folder whose contents it shows. */
  const mounted = [];
  const created = new Set();
  const cover = path => {
    let best;
    for (const entry of mounted)
      if (inside(path, entry.path) && (!best || entry.path.length > best.path.length)) best = entry;
    return best;
  };
  /** Whether `path` exists in the Candidate's view built so far. */
  const visible = path => {
    if (created.has(path)) return true;
    const by = cover(path);
    if (by) return exists(join(by.shows, path.slice(by.path.length)));
    if (path === home) return true;
    return !under(path) && exists(path);
  };
  for (const { path, kind } of entries) {
    const by = cover(path);
    // The source is what the runner sees at that path, or what an enclosing copy already shows.
    const source = by?.kind === 'copy' ? join(by.shows, path.slice(by.path.length)) : toReal(path);
    if (!exists(source) || (kind === 'copy' && !isDirectory(source))) continue;
    if (kind === 'ro' && by && by.kind !== 'rw') continue;
    if (under(path)) {
      let parent = home;
      for (const part of dirname(path).slice(home.length).split('/').filter(Boolean)) {
        parent = join(parent, part);
        if (!visible(parent)) {
          steps.push({ step: 'mkdir', path: parent });
          created.add(parent);
        }
      }
      if (!visible(path)) {
        steps.push({ step: isDirectory(source) ? 'mkdir' : 'touch', path });
        created.add(path);
      }
    }
    if (kind === 'copy') {
      const store = stateStore(path);
      steps.push({ step: 'copy', source, store }, { step: 'bind', source: store, path });
    } else {
      steps.push({ step: 'bind', source, path });
      if (kind === 'ro') steps.push({ step: 'ro', path });
    }
    mounted.push({ path, kind, shows: source });
  }
  return steps;
}

/** A .gitconfig for the Candidate's fresh home that trusts these toolchain checkouts (git refuses a
 * repository another user owns), or null. Never the home or a folder above it. */
export function gitSafeConfig(home, paths = []) {
  const safe = paths.filter(
    path => path.startsWith('/') && path !== '/' && !inside(home, path) && !/[\n\r"\\]/.test(path),
  );
  return safe.length ? `[safe]\n${safe.map(path => `\tdirectory = ${path}\n`).join('')}` : null;
}
