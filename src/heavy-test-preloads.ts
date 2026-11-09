// SPDX-License-Identifier: Apache-2.0
// A focused `node --test FILES` run skips whatever the project's own test script preloads
// (`--import ./tests/setup.mjs`, `--require …`). Setup such as a private HOME or a fake service is
// then missing, and a test can fail only on that machine (friction c804f164: a check-run test hit
// the real-user-state guard and reported a bare 'failed' !== 'passed'). Heavy says so before it runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRELOAD = new Set(['--import', '--require', '-r']);

/** Preload flags (`--import X`, `--import=X`, `--require X`, `-r X`) in one word list. */
function preloads(words: string[]) {
  const found: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const joined = /^(--import|--require)=(.+)$/.exec(word);
    if (joined) found.push(`${joined[1]} ${joined[2]}`);
    else if (PRELOAD.has(word) && words[i + 1])
      found.push(`${word === '-r' ? '--require' : word} ${words[++i]}`);
  }
  return found;
}

/** The preloads the project's `test` script passes to `node … --test` and `args` leaves out. Reads
 * package.json in `cwd` only; a missing, unreadable or non-node test script asks for nothing. */
export function missingTestPreloads(args: string[], cwd: string): string[] {
  let script: unknown;
  try {
    script = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))?.scripts?.test;
  } catch {
    return [];
  }
  if (typeof script !== 'string') return [];
  const wanted = new Set<string>();
  for (const segment of script.split(/&&|\|\||[;|]/)) {
    const words = segment.trim().split(/\s+/);
    if (!/(?:^|\/)node$/.test(words[0] ?? '') || !words.includes('--test')) continue;
    for (const flag of preloads(words.slice(1))) wanted.add(flag);
  }
  const own = new Set(preloads(args.slice(1)));
  return [...wanted].filter(flag => !own.has(flag));
}

export const preloadNotice = (missing: string[]) =>
  `heavy: this project's test script runs node --test with ${missing.join(' ')}; this command does not, ` +
  `so test setup it provides is missing here. Add ${missing.join(' ')} before --test.\n`;
