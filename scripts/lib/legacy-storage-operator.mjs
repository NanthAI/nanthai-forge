// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentOptions } from '../hosted-durability.mjs';
import { deploymentReader } from './legacy-storage-reader.mjs';
import { childEnv } from '../child-env.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
export function operatorIo(command) {
  if (
    !command.deployment.startsWith('dev:') ||
    /^(?:prod|preview|custom):/.test((process.env.CONVEX_DEPLOY_KEY ?? '').split('|')[0])
  )
    throw new Error('CLEANUP_DEV_DEPLOYMENT_REQUIRED');
  const selection = deploymentOptions(command.deployment);
  async function execute(executable, args, env = selection.env) {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => {
      output += b;
    });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
    let code;
    try {
      code = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
    } finally {
      clearTimeout(timeout);
    }
    if (code !== 0) throw new Error('CLEANUP_PROVIDER_FAILED');
    return output.trim();
  }
  const cli = args =>
    execute(process.execPath, [resolve(root, 'node_modules/convex/bin/main.js'), ...args, ...selection.args]);
  const baseReader = deploymentReader(command.deployment, root);
  let stopped = false;
  const reader = {
    ...baseReader,
    page: async source => {
      if (stopped) throw new Error('CLEANUP_INTERRUPTED');
      return baseReader.page(source);
    },
  };
  return {
    progress: event => console.error(JSON.stringify({ progress: event })),
    reader,
    stop: () => {
      stopped = true;
    },
    call: async (name, args) => {
      if (stopped) throw new Error('CLEANUP_INTERRUPTED');
      return JSON.parse(await cli(['run', name, JSON.stringify(args)]));
    },
    beginWindow: async operationId =>
      JSON.parse(await cli(['run', 'projectLegacyStorageWindow:begin', JSON.stringify({ operationId })])),
    endWindow: async operationId =>
      JSON.parse(await cli(['run', 'projectLegacyStorageWindow:end', JSON.stringify({ operationId })])),
    setFlag: (name, value) => cli(['env', 'set', name, value]),
    unsetFlag: name => cli(['env', 'remove', name]),
    async flagsAbsent() {
      return (
        (
          await baseReader.page(
            `return ['FORGE_LEGACY_STORAGE_PAUSE','FORGE_R2_MAINTENANCE'].filter(name=>process.env[name]!==undefined);`,
          )
        ).length === 0
      );
    },
    async backup() {
      const result = JSON.parse(
        await execute(
          'gh',
          [
            'run',
            'view',
            '41887010710',
            '--repo',
            'NanthAI/nanthai-forge',
            '--json',
            'databaseId,status,conclusion',
          ],
          childEnv({ allow: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'XDG_CONFIG_HOME'], extra: { CI: '1' } }),
        ),
      );
      if (
        result.databaseId !== 41887010710 ||
        result.status !== 'completed' ||
        result.conclusion !== 'success'
      )
        throw new Error('CLEANUP_BACKUP_REQUIRED');
      return {
        run: 41887010710,
        successful: true,
        includeFileStorage: true,
        checkedAt: new Date().toISOString(),
      };
    },
  };
}
