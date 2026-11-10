// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { childEnv } from '../scripts/child-env.mjs';

for (const command of ['clone', 'pull'])
  test(`hosted ${command} loads byte formats without native Work, graph or archive construction`, async t => {
    const home = mkdtempSync(join(tmpdir(), 'forge-clone-imports-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { registerHooks } from 'node:module';
    const loaded = new Set();
    registerHooks({ load(url, context, next) {
      loaded.add(url.split('/').at(-1));
      return next(url, context);
    }});
    // dist/cli-entry.js is a bundle (Issue 7b2ae8d8): its chunks carry no module names, so the modules
    // the entry imports for this command are loaded from the tsc output, which has the same graph.
    await import('./dist/cli-command-ready.js');
    await import('./dist/hosted-clone-cli.js');
    ${command === 'pull' ? "await import('./dist/hosted-pull-cli.js');" : ''}
    console.log(JSON.stringify([...loaded]));
  `,
      ],
      { env: childEnv({ extra: { HOME: home, TMPDIR: home, XDG_CONFIG_HOME: join(home, '.config') } }) },
    );
    const loaded = new Set(JSON.parse(stdout.trim().split('\n').at(-1)));
    assert(loaded.has('hosted-clone-cli.js'));
    for (const module of [
      'native-source.js',
      'native-source-review.js',
      'owner-derived.js',
      'native-exchange-tree.js',
      'exchange-receive-cache.js',
      'work-types.js',
      'work-store.js',
      'work.js',
    ])
      assert(!loaded.has(module), `clone eagerly loads ${module}`);
    assert(loaded.has('byte-tree-format.js'));
  });
