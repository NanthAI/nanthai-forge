// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { globPattern } from './autonomy-policy.js';
import {
  TOOLCHAIN_ACTIONS,
  cacheKeyPrefix,
  cacheLockfiles,
  cachePaths,
  type ActionsDeclaration,
} from './actions-toolchains.js';

/** The fixed App/OIDC workflow is shared by every project of its runner repository, so it
 * cannot inline one project's declaration. The planning job pins the declaration in the
 * recipe and writes these two outputs; the workflow's steps run only for declared tools. */
export type HostedToolchains = Partial<
  Record<
    'go' | 'python' | 'java' | 'dotnet',
    { version: string; versionFile: string; distribution?: string }
  > &
    Record<'rust', { version: string; directory: string }>
>;
export type HostedDepsCache = { key: string; paths: string; save: boolean } | Record<string, never>;

/** Version files are relative to the Candidate directory; the workflow adds its path. */
export function hostedToolchains(declaration: ActionsDeclaration | undefined): HostedToolchains {
  const out: HostedToolchains = {};
  for (const t of declaration?.toolchains ?? []) {
    if (t.tool === 'rust') {
      const file = t.versionFile ?? '';
      out.rust = {
        version: t.version ?? '',
        directory: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : file ? '.' : '',
      };
    } else
      out[t.tool] = {
        version: t.version ?? '',
        versionFile: t.versionFile ?? '',
        ...(t.tool === 'java' ? { distribution: t.distribution ?? 'temurin' } : {}),
      };
  }
  return out;
}

/** One entry per check: its presets' paths, keyed on the project, runner and the content hashes
 * of the declared lockfiles in the pinned State (no file read, no request). Only a main audit,
 * which checks accepted main, may save it; every other check restores read-only. */
export function hostedDepsCache(
  declaration: ActionsDeclaration | undefined,
  input: {
    projectId: string;
    files: readonly { path: string; blob: string }[];
    save: boolean;
    os?: string | undefined;
    arch?: string | undefined;
  },
): HostedDepsCache {
  const cache = declaration?.cache;
  if (!cache) return {};
  const patterns = cacheLockfiles(cache).map(globPattern);
  const locked = input.files
    .filter(file => patterns.some(pattern => pattern.test(file.path)))
    .map(file => [file.path, file.blob])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  const project = digest(input.projectId).slice(0, 16);
  return {
    key: `${cacheKeyPrefix(cache)}-${project}-${input.os ?? 'unknown'}-${input.arch ?? 'unknown'}-${digest(JSON.stringify(locked))}`,
    paths: cachePaths(cache).join('\n'),
    save: input.save,
  };
}

/** Steps for one job of the fixed workflow, after the Candidate is in `runner.temp/candidate`.
 * `outputs` is the expression prefix of the plan outputs (`steps.plan.outputs` in the planning
 * job, `needs.hosted-plan.outputs` in shard jobs); `when` limits them to jobs that execute. */
export function hostedDeclaredSteps(outputs: string, when = '') {
  const t = `fromJSON(${outputs}.toolchains || '{}')`;
  const file = (tool: string) =>
    `\${{ ${t}.${tool}.versionFile && format('{0}/candidate/{1}', runner.temp, ${t}.${tool}.versionFile) || '' }}`;
  const step = (tool: 'go' | 'python' | 'java' | 'dotnet', inputs: string) =>
    `      - if: ${when}${t}.${tool}\n        uses: ${TOOLCHAIN_ACTIONS[tool]}\n        with:\n${inputs}`;
  const d = `fromJSON(${outputs}.deps_cache || '{}')`;
  return (
    step(
      'go',
      `          go-version: \${{ ${t}.go.version }}\n          go-version-file: ${file('go')}\n          cache: false\n`,
    ) +
    step(
      'python',
      `          python-version: \${{ ${t}.python.version }}\n          python-version-file: ${file('python')}\n`,
    ) +
    step(
      'java',
      `          distribution: \${{ ${t}.java.distribution }}\n          java-version: \${{ ${t}.java.version }}\n          java-version-file: ${file('java')}\n`,
    ) +
    step(
      'dotnet',
      `          dotnet-version: \${{ ${t}.dotnet.version }}\n          global-json-file: ${file('dotnet')}\n`,
    ) +
    // Values reach the shell only through env, never through the script text.
    `      - if: ${when}${t}.rust\n        run: |\n` +
    `          if [ -n "$FORGE_RUST_VERSION" ]; then\n` +
    `            rustup toolchain install --profile minimal "$FORGE_RUST_VERSION" && rustup default "$FORGE_RUST_VERSION"\n` +
    `          else\n            cd "$RUNNER_TEMP/candidate/$FORGE_RUST_DIRECTORY" && rustup toolchain install\n          fi\n` +
    `        env:\n          FORGE_RUST_VERSION: \${{ ${t}.rust.version }}\n          FORGE_RUST_DIRECTORY: \${{ ${t}.rust.directory }}\n` +
    `      - if: ${when}${d}.key\n        id: forge-deps\n        uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4\n` +
    `        with:\n          path: \${{ ${d}.paths }}\n          key: \${{ ${d}.key }}\n`
  );
}
/** After the check command: a passing main audit with a cache miss saves the entry. */
export function hostedSaveSteps(outputs: string, when = '') {
  const d = `fromJSON(${outputs}.deps_cache || '{}')`;
  return (
    `      - if: ${when}steps.forge-deps.outcome == 'success' && steps.forge-deps.outputs.cache-hit != 'true' && ${d}.save\n` +
    `        uses: actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830 # v4\n` +
    `        with:\n          path: \${{ ${d}.paths }}\n          key: \${{ ${d}.key }}\n`
  );
}

/** Fixed-workflow step text, exactly as generated: the planning job (which executes only a
 * single-shard plan) and every shard job. A runner repository installs both. */
export const HOSTED_PLAN_WHEN = "steps.plan.outputs.single_shard != '' && ";
export const hostedWorkflowBlocks = () => [
  hostedDeclaredSteps('steps.plan.outputs', HOSTED_PLAN_WHEN),
  hostedSaveSteps('steps.plan.outputs', HOSTED_PLAN_WHEN),
  hostedDeclaredSteps('needs.hosted-plan.outputs'),
  hostedSaveSteps('needs.hosted-plan.outputs', "matrix.shard == 'static' && "),
];
/** A runner repository whose forge-check.yml predates these steps would run a declared check
 * without its toolchains; planning refuses instead and names the reinstall. */
export function declaredStepsInstalled(workflow: string | undefined) {
  return workflow === undefined || hostedWorkflowBlocks().every(block => workflow.includes(block));
}
export const ACTIONS_WORKFLOW_OUTDATED =
  "This check declares toolchains or cache, but the runner repository's forge-check.yml has no declared-setup steps. Reinstall forge-check.yml (docs/operations/github-actions-checks.md#toolchains-and-dependency-cache).";
