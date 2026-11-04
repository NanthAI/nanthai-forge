// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseStages } from '../dist/maintainer-release-schema.js';
import { RECOVERY_HELP, recoveryCli } from '../dist/recovery-cli.js';

const root = fileURLToPath(new URL('..', import.meta.url));
test('retired owner runtime entry points remain removed', () => {
  for (const path of [
    'src/http.ts',
    'src/work-http.ts',
    'src/work-git-http.ts',
    'src/native-git-http.ts',
    'src/work-git-receive.ts',
    'src/work-git-receive-hook.ts',
    'src/native-git-receive.ts',
    'src/native-git-receive-hook.ts',
    'src/work-git-stream.ts',
    'src/recovery-native-owner.ts',
    'src/recovery-owner.ts',
    'src/local-acceptance.ts',
    'src/maintainer-release-owner.ts',
    'src/release-owner-supervisor.ts',
    'src/release-owner-runtime.ts',
    'src/release-owner-selection.ts',
    'src/release-owner-processes.ts',
  ])
    assert.equal(existsSync(join(root, path)), false, path);
  assert(!releaseStages.includes('owner'));
  const cli = readFileSync(join(root, 'src/cli.ts'), 'utf8');
  assert.doesNotMatch(cli, /nforge serve|args\[0\] === 'serve'/);
  assert.doesNotMatch(RECOVERY_HELP, /reconnect\|client/);
});
test('native reconnect/client verbs cannot start recovery', async () => {
  for (const verb of ['reconnect', 'client'])
    await assert.rejects(recoveryCli(['/unused', verb, '--command-file', '/unused']), {
      code: 'BAD_ARGUMENT',
    });
});

test('no source, script or test can call the retired serve CLI verb', () => {
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '_generated' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.(?:ts|tsx|mjs)$/.test(path) && path !== fileURLToPath(import.meta.url))
        assert.doesNotMatch(readFileSync(path, 'utf8'), /['"]serve['"]/, path);
    }
  }
  for (const directory of ['src', 'scripts', 'tests']) scan(join(root, directory));
});
