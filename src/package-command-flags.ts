// SPDX-License-Identifier: Apache-2.0
import { parseForgeJson } from './project-config.js';
import { ciFlags, FLAG_ECOSYSTEMS, type CiFlags, type FlagEcosystem } from './package-ci-flags.js';
import type { Ecosystem, PackageCommand } from './package-graph-types.js';

/** How a scoped package run keeps the project's own test flags (Issue b94681af). Portable, with no file
 * system: the package graph reaches this module in Convex; the file readers are in
 * src/package-command-flags-checkout.ts. Two sources, in order:
 * 1. a declared template per ecosystem in a root `forge.json`, used verbatim:
 *    `{"packages":{"commands":{"cargo":["cargo","test","--all-features","{packages}"]}}}`, where the
 *    element `{packages}` expands to the words Forge selected after the tool (`-p a -p b`; for Gradle
 *    the tasks, for Maven the selection and phase, for pytest the paths);
 * 2. the flags the project's own CI passes, read from the declared check's text (src/package-ci-flags.ts).
 * With neither, the bare command is used, as before. An unreadable template or CI text Forge cannot
 * place makes the ecosystem's selection full (`refusal`), never a narrower run than the CI's. */
export type PackageFlagSource = {
  /** Declared templates by ecosystem. */
  templates: Partial<Record<Ecosystem, string[]>>;
  /** Text of the declared check (its words and script files) to read the CI's flags from. */
  ciText?: string | undefined;
};

const PLACEHOLDER = '{packages}';

/** `packages.commands` of a forge.json text, or the error that makes it unusable. */
export function declaredPackageTemplates(
  forgeJson: string | undefined,
): { templates: Partial<Record<Ecosystem, string[]>> } | { error: string } {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = parseForgeJson(forgeJson);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const packages = parsed?.packages;
  const commands =
    packages && typeof packages === 'object' ? (packages as Record<string, unknown>).commands : undefined;
  if (commands === undefined) return { templates: {} };
  if (!commands || typeof commands !== 'object' || Array.isArray(commands))
    return { error: 'forge.json packages.commands must be an object of ecosystem → argv' };
  const templates: Partial<Record<Ecosystem, string[]>> = {};
  for (const [name, argv] of Object.entries(commands)) {
    if (!FLAG_ECOSYSTEMS.includes(name as Ecosystem))
      return { error: `forge.json packages.commands.${name}: no template for that ecosystem` };
    const valid =
      Array.isArray(argv) &&
      argv.length >= 2 &&
      argv.every(word => typeof word === 'string' && word) &&
      argv.filter(word => word === PLACEHOLDER).length === 1;
    if (!valid)
      return {
        error: `forge.json packages.commands.${name} needs an argv with the tool and exactly one "${PLACEHOLDER}" element`,
      };
    templates[name as Ecosystem] = argv as string[];
  }
  return { templates };
}

/** The words of a generated command that the tool's name and subcommand take, and the selection after. */
function split(ecosystem: FlagEcosystem, argv: string[]) {
  const head =
    ecosystem === 'python'
      ? argv.findIndex(word => word === 'pytest') + 1
      : ecosystem === 'gradle' || ecosystem === 'maven'
        ? 1
        : 2;
  return { head: argv.slice(0, Math.max(head, 1)), select: argv.slice(Math.max(head, 1)) };
}

function withFlags(ecosystem: FlagEcosystem, argv: string[], flags: CiFlags) {
  const { head, select } = split(ecosystem, argv);
  const words = flags.task
    ? select.map(word =>
        ecosystem === 'maven'
          ? word === 'test'
            ? flags.task!
            : word
          : word.replace(/(^|:)test$/, `$1${flags.task}`),
      )
    : select;
  return [...head, ...flags.before, ...words, ...(flags.after.length ? ['--', ...flags.after] : [])];
}

/** Commands of one ecosystem with the project's flags, or why the selection must be full. */
export function applyPackageFlags(
  ecosystem: Ecosystem,
  commands: PackageCommand[],
  source: PackageFlagSource | undefined,
): PackageCommand[] | { refusal: string } {
  if (!source || !FLAG_ECOSYSTEMS.includes(ecosystem) || !commands.length) return commands;
  const flagged = ecosystem as FlagEcosystem;
  const template = source.templates[ecosystem];
  if (template)
    return commands.map(command => ({
      ...command,
      // The template replaces the tool words; the placeholder takes the selection after them.
      argv: template.flatMap(word => (word === PLACEHOLDER ? split(flagged, command.argv).select : [word])),
      flagsFrom: 'forge.json' as const,
    }));
  if (!source.ciText) return commands;
  const found = ciFlags(source.ciText, flagged);
  if (found === null) return commands;
  if ('unsure' in found) return { refusal: `${found.unsure}; declare packages.commands in forge.json` };
  return commands.map(command => ({
    ...command,
    argv: withFlags(flagged, command.argv, found),
    flagsFrom: 'ci' as const,
  }));
}

/** Flags a caller without a declared check (preflight, the Intent contract) can still apply: forge.json templates. */
export function declaredPackageFlags(forgeJson: string | undefined): PackageFlagSource | { refusal: string } {
  const declared = declaredPackageTemplates(forgeJson);
  return 'error' in declared ? { refusal: declared.error } : { templates: declared.templates };
}
