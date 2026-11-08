// SPDX-License-Identifier: Apache-2.0
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/** A preflight command whose program is not installed here is an environment result, not a failed
 * run: the machine lacks the toolchain (cargo, go, uv, java…), and the landing check, which sets up
 * its own, still runs those tests. Reads PATH entries and file modes only; never runs anything. */
export const toolchainEnvironmentSchema = z
  .object({
    category: z.literal('ENVIRONMENT'),
    code: z.literal('TOOLCHAIN_MISSING'),
    message: z.string(),
    next: z.string(),
    /** Programs not found here, in the order the run met them. */
    missing: z.array(z.string()).min(1),
    /** Preflight units (or test files) not run, or not judged, because of it. */
    units: z.array(z.string()),
  })
  .strict();
export type ToolchainEnvironment = z.infer<typeof toolchainEnvironmentSchema>;

/** Shell and spawn conventions for "the program was not found": 127 from a shell or `time`
 * wrapper, ENOENT from a direct spawn. */
export const missingProgramExit = (status: number | null, errorCode?: string | null) =>
  status === 127 || errorCode === 'ENOENT';

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether `program` resolves to an executable: a path (absolute, or relative to `cwd`) when it
 * holds a slash, else a PATH entry. On Windows (PATHEXT lookup) it is never judged missing here;
 * the spawn result still is. */
export function programAvailable(program: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === 'win32') return true;
  if (program.includes('/')) return executable(isAbsolute(program) ? program : join(cwd, program));
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some(dir => executable(join(dir, program)));
}

/** Runtimes an ecosystem's build tool needs besides its own launcher: the Gradle and Maven
 * wrappers start a JVM. */
function runtimeMissing(ecosystem: string | undefined, cwd: string, env: NodeJS.ProcessEnv) {
  if (ecosystem !== 'gradle' && ecosystem !== 'maven') return null;
  const home = env.JAVA_HOME;
  if (home && executable(join(home, 'bin', 'java'))) return null;
  return programAvailable('java', cwd, env) ? null : 'java';
}

/** The first program a command needs that is not installed here, or null. */
export function missingToolchain(
  command: { argv: string[]; ecosystem?: string | undefined },
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const program = command.argv[0];
  if (!program) return null;
  if (!programAvailable(program, cwd, env)) return program;
  return runtimeMissing(command.ecosystem, cwd, env);
}

export function toolchainEnvironment(missing: string[], units: string[], next: string): ToolchainEnvironment {
  const names = [...new Set(missing)];
  return {
    category: 'ENVIRONMENT',
    code: 'TOOLCHAIN_MISSING',
    message:
      `Not installed on this machine: ${names.join(', ')}. ${units.length} preflight unit(s) could not run here; ` +
      'that is this machine, not a failed run. The landing check runs them with its own setup.',
    next,
    missing: names,
    units,
  };
}
