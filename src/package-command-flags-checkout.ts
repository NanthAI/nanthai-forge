// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { declaredPackageTemplates, type PackageFlagSource } from './package-command-flags.js';

/** The file-reading half of the package test flags (src/package-command-flags.ts), for a checked-out
 * Candidate only: node:fs stays out of the portable package graph. */
const MAX_SCRIPT_BYTES = 256 * 1024;
/** Text of a declared check for flag reading: its words, and the repository script files they name
 * (an argument or the executable that is a file inside the checkout). Nothing outside the checkout. */
export function checkText(directory: string, check: { executable: string; args: readonly string[] }) {
  const root = resolve(directory);
  const parts = [[check.executable, ...check.args].join(' ')];
  for (const word of [check.executable, ...check.args]) {
    if (!word || word.startsWith('-')) continue;
    const path = isAbsolute(word) ? resolve(word) : resolve(root, word);
    if (path !== root && !path.startsWith(root + sep)) continue;
    try {
      if (existsSync(path) && statSync(path).isFile() && statSync(path).size <= MAX_SCRIPT_BYTES)
        parts.push(readFileSync(path, 'utf8'));
    } catch {
      // Unreadable: nothing is learned from it.
    }
  }
  return parts.join('\n');
}

/** The flag source for a checked-out Candidate: its forge.json templates and the declared check's text. */
export function checkoutPackageFlags(
  directory: string,
  check?: { executable: string; args: readonly string[] },
): PackageFlagSource | { refusal: string } {
  let forgeJson: string | undefined;
  try {
    forgeJson = readFileSync(join(directory, 'forge.json'), 'utf8');
  } catch {
    // No forge.json.
  }
  const declared = declaredPackageTemplates(forgeJson);
  if ('error' in declared) return { refusal: declared.error };
  return { templates: declared.templates, ciText: check ? checkText(directory, check) : undefined };
}
