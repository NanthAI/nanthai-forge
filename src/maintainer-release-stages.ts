// SPDX-License-Identifier: Apache-2.0
import { withQueueSlot } from './landing-queue.js';
import { selectReleaseOwner } from './maintainer-release-owner.js';
import { childEnv } from '../scripts/child-env.mjs';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exportNativeGit } from './native-git.js';
import { invariant } from './errors.js';
import { parseEnv } from 'node:util';
import {
  releaseHash,
  releaseJson,
  releaseQuote,
  releaseWrite,
  releaseSelection,
} from './maintainer-release-files.js';
import type { ReleaseJournal, ReleaseStage } from './maintainer-release-schema.js';

export class ReleaseChildFailure extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signal: string | null,
  ) {
    super('Release child failed.');
  }
}
export function releaseCommand(
  command: string,
  args: string[],
  cwd: string,
  env = childEnv({
    allow: ['npm_execpath', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig'],
  }),
) {
  const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0 || result.error) throw new ReleaseChildFailure(result.status, result.signal);
}
export function releaseResult(journal: ReleaseJournal, name: ReleaseStage) {
  return journal.stages.find(stage => stage.name === name)!.attempts.at(-1)!.receipt!.result;
}
export async function executeReleaseStage(
  journal: ReleaseJournal,
  name: ReleaseStage,
  directory: string,
  dependencies = { run: releaseCommand, exportSource: exportNativeGit },
): Promise<Record<string, string>> {
  const run = dependencies.run;
  const npm = (args: string[], cwd: string) => run(journal.node, [journal.request.npmCli, ...args], cwd);
  if (name === 'export') {
    const output = await dependencies.exportSource(
      journal.owner,
      journal.head,
      join(directory, 'export'),
      journal.request.reuseExport,
    );
    return { path: output.path, commit: output.commit };
  }
  if (name === 'build') {
    const exported = releaseResult(journal, 'export');
    const build = join(directory, 'source');
    run(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'clone',
        '--no-checkout',
        '--',
        join(exported.path!, 'repository.git'),
        build,
      ],
      directory,
    );
    run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', exported.commit!], build);
    // Only explicitly selected local configuration; never put its values in receipts.
    copyFileSync(join(journal.request.configurationDirectory, '.env.local'), join(build, '.env.local'));
    mkdirSync(join(build, '.netlify'), { mode: 0o700 });
    copyFileSync(
      join(journal.request.configurationDirectory, '.netlify', 'state.json'),
      join(build, '.netlify', 'state.json'),
    );
    const configuration = parseEnv(readFileSync(join(build, '.env.local'), 'utf8'));
    npm(['ci', '--ignore-scripts'], build);
    run(
      journal.node,
      [journal.request.npmCli, 'run', 'build'],
      build,
      childEnv({
        source: configuration,
        extra: childEnv(),
        allow: [
          'VITE_CONVEX_URL',
          'VITE_CLERK_PUBLISHABLE_KEY',
          'VITE_FORGE_DEMO_REPOSITORY',
          'VITE_FORGE_PERF',
        ],
      }),
    );
    return {
      path: build,
      version: String((releaseJson(join(build, 'package.json')) as { version: string }).version),
      head: journal.head,
    };
  }
  const build = releaseResult(journal, 'build').path!;
  if (name === 'backend' || name === 'web') {
    const configuration = parseEnv(readFileSync(join(build, '.env.local'), 'utf8'));
    // Only the selected Convex/Netlify CLIs consume these deployment credentials.
    const environment = childEnv({
      source: configuration,
      extra: childEnv(),
      allow: [
        'CONVEX_DEPLOY_KEY',
        'CONVEX_DEPLOYMENT',
        'CONVEX_SELF_HOSTED_URL',
        'CONVEX_SELF_HOSTED_ADMIN_KEY',
        'NETLIFY_AUTH_TOKEN',
        'VITE_CONVEX_URL',
        'VITE_CLERK_PUBLISHABLE_KEY',
        'VITE_FORGE_DEMO_REPOSITORY',
      ],
    });
    if (name === 'backend')
      run(
        journal.node,
        [journal.request.npmCli, 'exec', '--', 'convex', 'dev', '--once'],
        build,
        environment,
      );
    else run(journal.node, ['scripts/deploy-forge-preview.mjs', '--prod'], build, environment);
    return { head: journal.head, source: build, mode: name === 'backend' ? 'dev' : 'production-site' };
  }
  if (name === 'package') {
    run(
      journal.node,
      ['scripts/package-local.mjs', '--out', directory],
      build,
      childEnv({
        extra: { npm_execpath: journal.request.npmCli },
        allow: ['npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig'],
      }),
    );
    const archives = readdirSync(directory).filter(path => path.endsWith('.tgz'));
    invariant(archives.length === 1, 'INVALID_RELEASE_PACKAGE', 'Expected exactly one packaged CLI.');
    const path = join(directory, archives[0]!);
    return { path, sha256: releaseHash(readFileSync(path)) };
  }
  if (name === 'install') {
    const archive = releaseResult(journal, 'package');
    invariant(
      releaseHash(readFileSync(archive.path!)) === archive.sha256,
      'INVALID_RELEASE_PACKAGE',
      'Packaged CLI bytes changed.',
    );
    writeFileSync(join(directory, 'package.json'), '{"private":true}\n', { flag: 'wx', mode: 0o600 });
    npm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', archive.path!], directory);
    const cli = join(directory, 'node_modules', '@nanthai', 'forge', 'dist', 'cli.js');
    invariant(existsSync(cli), 'INVALID_RELEASE_PACKAGE', 'Installed CLI entry point is absent.');
    run(journal.node, [cli, '--version'], directory);
    return { path: directory, cli, head: journal.head };
  }
  const installed = releaseResult(journal, 'install');
  if (name === 'owner') {
    // A lost child start marker may leave a survivor: serialize the resumable
    // owner plan across stage processes before any selection or supervisor IO.
    const result = await withQueueSlot(
      join(journal.directory, 'owner-stage-queue'),
      () => selectReleaseOwner(journal, installed.path!, installed.cli!),
      { anchor: journal.directory },
    );
    invariant('value' in result, 'RELEASE_RUNNING', 'Owner selection is still running.');
    return result.value;
  }
  const wrapper = `#!/bin/sh\nexport FORGE_CHECK_SCOPED=1\nexec ${releaseQuote(journal.node)} ${releaseQuote(installed.cli!)} "$@"\n`;
  const selected = journal.request.cliPath;
  // Reconcile a lost reply after the rename before checking the previous selection.
  if (releaseSelection(selected).kind === 'file' && readFileSync(selected).equals(Buffer.from(wrapper)))
    return { path: selected, head: journal.head };
  const current = releaseSelection(selected);
  invariant(
    current.exists === journal.previousCli.exists &&
      current.kind === journal.previousCli.kind &&
      current.sha256 === journal.previousCli.sha256,
    'CLI_SELECTION_CHANGED',
    'CLI selection changed during release; the current selection is preserved.',
  );
  mkdirSync(dirname(selected), { recursive: true, mode: 0o700 });
  releaseWrite(selected, wrapper, 0o755);
  return { path: selected, head: journal.head };
}
