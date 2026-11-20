// SPDX-License-Identifier: Apache-2.0
// A focused `node --test FILES` run skips whatever the project's own test script preloads
// (`--import ./tests/setup.mjs`, `--require …`). Setup such as a private HOME or a fake service is
// then missing, and a test can fail only on that machine (friction c804f164: a check-run test hit
// the real-user-state guard and reported a bare 'failed' !== 'passed'). Heavy refuses such a command
// before it takes a slot or runs anything, including `sh -c "build && node --test …"` (dfb2a8d6,
// where the build ran first and only the test failed inside the test process).
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const TEST_FLAG = '--test';
const PRELOAD = new Set(['--import', '--require', '-r']);
const SEPARATORS = /(&&|\|\||[;|])/;
const SHELLS = new Set(['sh', 'bash']);

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

/** The `node … --test` segments of a shell string (separators kept at the odd indexes of `parts`). */
function nodeTestSegments(text: string) {
  const parts = text.split(SEPARATORS);
  const found: { at: number; words: string[] }[] = [];
  parts.forEach((part, at) => {
    if (at % 2) return;
    const words = part.trim().split(/\s+/);
    if (/(?:^|\/)node$/.test(words[0] ?? '') && words.includes(TEST_FLAG)) found.push({ at, words });
  });
  return { parts, found };
}

/** The preloads of the project's `test` script (package.json in `cwd` only); a missing, unreadable
 * or non-node test script asks for nothing. */
function wantedPreloads(cwd: string) {
  const wanted = new Set<string>();
  let script: unknown;
  try {
    script = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))?.scripts?.test;
  } catch {
    return wanted;
  }
  if (typeof script !== 'string') return wanted;
  for (const { words } of nodeTestSegments(script).found)
    for (const flag of preloads(words.slice(1))) wanted.add(flag);
  return wanted;
}

const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The refusal for a heavy command whose `node --test` leaves out preloads the project's test script
 * passes: a direct `node --test`, or a node segment inside one `sh -c`/`bash -c` string. Names the
 * missing flags and the corrected command; it never rewrites what runs. Null when nothing is missing.
 * Reads package.json only for a command that could be such a test. */
export function preloadRefusal(args: string[], cwd: string): string | null {
  const first = args[0] ?? '';
  const shell = SHELLS.has(basename(first)) && args[1] === '-c' && typeof args[2] === 'string';
  const direct = first === process.execPath || /(?:^|\/)node(?:\.exe)?$/.test(first);
  if (shell ? !args[2]!.includes(TEST_FLAG) : !direct || !args.includes(TEST_FLAG)) return null;
  const wanted = wantedPreloads(cwd);
  if (!wanted.size) return null;
  // A preload the caller exports in NODE_OPTIONS reaches the test runner too.
  const inherited = preloads((process.env.NODE_OPTIONS ?? '').split(/\s+/));
  const lacking = (words: string[]) => {
    const own = new Set([...preloads(words), ...inherited]);
    return [...wanted].filter(flag => !own.has(flag));
  };
  let missing: string[];
  let corrected: string;
  if (shell) {
    const { parts, found } = nodeTestSegments(args[2]!);
    const all = new Set<string>();
    for (const { at, words } of found) {
      const need = lacking(words.slice(1));
      for (const flag of need) all.add(flag);
      if (need.length)
        parts[at] = parts[at]!.replace(/^(\s*\S*node)(?=\s)/, head => `${head} ${need.join(' ')}`);
    }
    missing = [...all];
    corrected = `${first} -c ${quote(parts.join(''))}`;
  } else {
    missing = lacking(args.slice(1));
    corrected = [first, ...missing.flatMap(flag => flag.split(' ')), ...args.slice(1)].map(quote).join(' ');
  }
  if (!missing.length) return null;
  return (
    `heavy: refused before taking a slot or running anything: this project's test script runs node --test ` +
    `with ${missing.join(' ')}; this command's node --test does not, so test setup it provides is missing ` +
    `(a test would fail on the real user path). Add ${missing.join(' ')} before --test. ` +
    `Corrected command: nforge heavy ${corrected}`
  );
}
