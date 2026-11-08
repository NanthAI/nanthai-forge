#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Per-ecosystem package runner (docs/workflows.md#check-command-scope). On a scoped hosted check,
// Forge writes FORGE_CHECK_PACKAGES (the affected packages and each ecosystem's own test command:
// go test, cargo test -p, gradle :mod:test, pytest paths, workspace npm/pnpm/yarn tests, dotnet test)
// and FORGE_CHECK_PACKAGES_RUN, an executable that calls this script. A repository's own CI script
// opts in with one line at its test step, after its setup:
//
//   [ -z "${FORGE_CHECK_PACKAGES_RUN:-}" ] || exec "$FORGE_CHECK_PACKAGES_RUN"
//
// Forge sets the variable only when the graph selected runnable packages; otherwise the script goes
// on with its full steps. Commands run in order, without a shell, in the checkout, with the CI
// script's own environment; every command runs, and the exit code is the first failure's.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Validated commands of a packages file, or an error message. */
export function packageRunCommands(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return { error: 'the packages file is not JSON' };
  }
  if (file?.version !== 1) return { error: 'unsupported packages file version' };
  if (file.scope !== 'scoped') return { error: `the package graph scope is ${JSON.stringify(file.scope)}` };
  const commands = Array.isArray(file.commands) ? file.commands : [];
  const valid = commands.every(
    command =>
      typeof command?.cwd === 'string' &&
      !isAbsolute(command.cwd) &&
      !command.cwd.split('/').includes('..') &&
      Array.isArray(command.argv) &&
      command.argv.length > 0 &&
      command.argv.every(word => typeof word === 'string' && word.length > 0),
  );
  if (!commands.length || !valid) return { error: 'the packages file names no runnable command' };
  return { commands };
}

const display = command =>
  `${command.cwd ? `(cd ${command.cwd} && ` : ''}${command.argv.join(' ')}${command.cwd ? ')' : ''}`;

/** Runs every command in `root`; returns the exit code (the first failure's, 0 when all pass). */
export function runPackageCommands(commands, root, { spawn = spawnSync, log = console.log } = {}) {
  let code = 0;
  for (const command of commands) {
    log(`forge packages: ${command.ecosystem ?? 'package'}: ${display(command)}`);
    const result = spawn(command.argv[0], command.argv.slice(1), {
      cwd: join(root, command.cwd),
      stdio: 'inherit',
      shell: false,
    });
    const status = result.error ? 127 : (result.status ?? 1);
    if (result.error) log(`forge packages: cannot run ${command.argv[0]}: ${result.error.code ?? 'error'}`);
    if (status !== 0 && code === 0) code = status;
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packagesFile, root = process.cwd()] = process.argv.slice(2);
  const parsed = packagesFile
    ? packageRunCommands(readFileSync(packagesFile, 'utf8'))
    : { error: 'usage: check-packages-run.mjs PACKAGES_FILE [ROOT]' };
  if (parsed.error) {
    // Never pass silently: a scoped check that cannot run its packages fails.
    console.error(`forge packages: ${parsed.error}; run the full check instead`);
    process.exit(2);
  }
  const code = runPackageCommands(parsed.commands, root);
  // The command's scope report (FORGE_CHECK_SELECTION): what it ran, never paths or output.
  if (process.env.FORGE_CHECK_SELECTION)
    try {
      writeFileSync(
        process.env.FORGE_CHECK_SELECTION,
        JSON.stringify({ scope: 'scoped', by: 'forge-check-packages', commands: parsed.commands.length }),
      );
    } catch {
      // The report is advisory; the exit code is the evidence.
    }
  console.log(
    `forge packages: ${parsed.commands.length} command(s), ${code === 0 ? 'passed' : `exit ${code}`}`,
  );
  process.exit(code);
}
