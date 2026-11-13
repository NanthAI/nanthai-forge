// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const harness of ['codex', 'claude', 'pi', 'opencode']) {
  test(
    `${harness}: real executable ancestry selects its own session over inherited client sessions`,
    { skip: process.platform === 'win32' },
    async t => {
      const dir = mkdtempSync(join(tmpdir(), 'forge-native-session-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const executable = join(dir, harness);
      symlinkSync(process.execPath, executable);
      const slugModule = new URL('../dist/agent-slug-session.js', import.meta.url).href;
      const variable = {
        codex: 'CODEX_THREAD_ID',
        claude: 'CLAUDE_CODE_SESSION_ID',
        pi: 'PI_SESSION_ID',
        opencode: 'OPENCODE_SESSION_ID',
      }[harness];
      const wakeModule = new URL('../dist/agent-wake.js', import.meta.url).href;
      const probe = `import { backgroundWake } from ${JSON.stringify(wakeModule)}; import { sessionAgentSlug, agentSlug } from ${JSON.stringify(slugModule)}; console.log(JSON.stringify({run:sessionAgentSlug(),wake:backgroundWake()??null,expected:agentSlug(process.env[${JSON.stringify(variable)}])}));`;
      // Linux reports the Node executable behind a symlink, not its alias. Give the
      // fixture a real process title, as named clients do, before it starts tool shells.
      const client = `import {spawnSync} from 'node:child_process';process.title=${JSON.stringify(harness)};for(let n=0;n<2;n++){const r=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(probe)}],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);}`;
      const run = own =>
        new Promise((resolve, reject) => {
          const env = {
            ...process.env,
            CLAUDE_CODE_SESSION_ID: 'parent-claude',
            CODEX_THREAD_ID: 'parent-codex',
            PI_SESSION_ID: 'parent-pi',
            OPENCODE_SESSION_ID: 'parent-opencode',
            [variable]: own,
          };
          delete env.FORGE_AGENT_SESSION;
          delete env.FORGE_HUMAN;
          delete env.FORGE_AGENT_WAKE;
          const child = spawn(executable, ['--input-type=module', '-e', client], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '',
            stderr = '';
          child.stdout.on('data', data => (stdout += data));
          child.stderr.on('data', data => (stderr += data));
          child.once('error', reject);
          child.once('exit', code =>
            code === 0 ? resolve(stdout.trim().split('\n').map(JSON.parse)) : reject(Error(stderr)),
          );
        });
      const [one, two] = await Promise.all([run('child-one'), run('child-two')]);
      for (const session of [one, two]) {
        assert.equal(session.length, 2);
        assert.equal(session[0].run, session[0].expected, 'the innermost process owns the run');
        assert.equal(
          session[0].wake,
          harness === 'claude' ? 'background' : null,
          'wake capability follows the inner client',
        );
        assert.equal(session[1].run, session[0].run, 'fresh command processes keep the same agent session');
      }
      assert.notEqual(one[0].run, two[0].run, 'simultaneous siblings differ');
    },
  );
}
