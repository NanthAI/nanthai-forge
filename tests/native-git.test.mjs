// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { importNativeGit, exportNativeGit } from '../dist/native-git.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkService } from '../dist/work.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { workGit } from '../dist/work-git.js';

const git = (root, ...args) => workGit(root, args);
for (const format of ['sha1', 'sha256'])
  test(
    `native ${format} boundary preserves original history and maps Git-free work`,
    { timeout: 120000 },
    async t => {
      const dir = mkdtempSync(join(tmpdir(), 'forge-native-git-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const root = join(dir, 'original');
      mkdirSync(root);
      git(dir, 'init', '--template=', `--object-format=${format}`, '--initial-branch=main', root);
      writeFileSync(join(root, '.gitignore'), '.forge/\n*.scratch\n');
      writeFileSync(join(root, 'secrets.ts'), 'export const secretNames=[];');
      writeFileSync(join(root, '.env.example'), 'PUBLIC_TEMPLATE=placeholder');
      writeFileSync(join(root, '.gitattributes'), 'binary.bin export-ignore\n');
      writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
      writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 128, 10]));
      writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(root, 'run.sh'), 0o700);
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'Original base');
      const base = git(root, 'rev-parse', 'HEAD').trim();
      git(root, 'checkout', '-b', 'side');
      writeFileSync(join(root, 'side.ts'), 'export const side=1;');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'Side');
      const side = git(root, 'rev-parse', 'HEAD').trim();
      git(root, 'checkout', 'main');
      writeFileSync(join(root, 'main.ts'), 'export const main=1;');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'Main');
      git(root, 'merge', '--no-ff', '-m', 'Original merge', 'side');
      const head = git(root, 'rev-parse', 'HEAD').trim();
      const tree = git(root, 'rev-parse', `${head}^{tree}`).trim();
      const raw = Buffer.from(
        `tree ${tree}\nparent ${head}\nauthor Original Author <original@example.invalid> 1700000000 +0000\ncommitter Original Committer <original@example.invalid> 1700000001 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n unverified-original-field\n -----END PGP SIGNATURE-----\n\nOriginal attributed bytes\n`,
      );
      const original = workGit(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], raw).trim();
      git(root, 'update-ref', 'refs/heads/main', original, head);
      git(root, 'reset', '--hard', original);
      git(root, 'tag', 'original-tag', base);
      writeFileSync(join(root, 'a.ts'), 'unfinished original work');
      const before = git(root, 'status', '--porcelain=v1');
      const target = join(dir, 'native'),
        imported = await importNativeGit(root, original, target);
      assert.equal(imported.format, format);
      assert.equal(existsSync(join(target, '.git')), false);
      assert.equal(git(root, 'status', '--porcelain=v1'), before);
      assert.equal(git(root, 'rev-parse', 'main').trim(), original);
      assert.deepEqual(readFileSync(join(target, 'binary.bin')), Buffer.from([0, 255, 128, 10]));
      assert.equal(new WorkService(target).store.load().autonomyPolicy.preset, 'supervised');
      const source = new NativeSource(target);
      assert.equal(source.state(imported.head).git.commit, original);
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const called = join(dir, 'git-called');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`);
      chmodSync(join(bin, 'git'), 0o700);
      for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
      const previous = process.env.PATH;
      process.env.PATH = bin;
      let changed, backup;
      try {
        const w = new WorkService(target),
          act = c => w.execute(c, w.status().revision).result;
        const intent = act({ action: 'intent', outcome: 'Develop imported native source' }),
          lane = act({ action: 'lane', intentId: intent.id, name: 'Native edit' });
        const path = w.store.path(lane.id);
        writeFileSync(join(path, 'a.ts'), 'export const a=2;\n');
        writeFileSync(join(path, 'new.bin'), Buffer.from([254, 0, 253]));
        const selected = w.status().lanes[0];
        changed = act({
          action: 'checkpoint',
          laneId: lane.id,
          expectedHead: selected.head,
          expectedTree: selected.indexTree,
          message: 'Native change',
        }).head;
        const view = act({
          action: 'compose',
          intentId: intent.id,
          inputs: [{ laneId: lane.id, head: changed }],
        });
        act({
          action: 'accept-channel',
          operationId: randomUUID(),
          channel: 'main',
          viewId: view.id,
          expectedHead: changed,
          expectedPrevious: null,
        });
        const check = act({
          action: 'define-check',
          name: 'Source bytes',
          executable: process.execPath,
          args: [
            '-e',
            "const fs=require('fs');if(!fs.readFileSync('a.ts','utf8').includes('a=2'))process.exit(2);console.log('native imported check')",
          ],
        });
        const env = w.status().environment;
        await w.dispatch(
          {
            action: 'run-check',
            operationId: randomUUID(),
            viewId: view.id,
            expectedHead: changed,
            checkId: check.id,
            expectedDefinition: check.definition,
            expectedEnvironment: env.fingerprint,
          },
          w.status().revision,
        );
        for (let n = 0; n < 300 && !['passed', 'failed'].includes(w.status().runs[0].status); n++)
          await new Promise(r => setTimeout(r, 20));
        assert.equal(w.status().runs[0].status, 'passed');
        assert.equal(
          existsSync(join(w.store.directory, 'check-' + w.status().runs[0].id, 'workspace')),
          false,
        );
        backup = (await w.dispatch({ action: 'export-work', archive: true }, w.status().revision)).result;
        await restoreNativeWork(backup.archive.path, join(dir, 'restored'));
        const restored = new WorkService(join(dir, 'restored'));
        assert.equal(restored.status().channels[0].head, changed);
        assert.equal(restored.status().runs[0].status, 'passed');
        assert.equal(
          new NativeSource(restored.store.root).state(imported.head).git.bundle,
          source.state(imported.head).git.bundle,
        );
        assert.equal(existsSync(called), false);
      } finally {
        process.env.PATH = previous;
      }
      const exported = await exportNativeGit(join(dir, 'restored'), changed, join(dir, 'projection'));
      const repeated = await exportNativeGit(target, changed, join(dir, 'projection-again'));
      assert.equal(repeated.commit, exported.commit);
      assert.deepEqual(repeated.states, exported.states);
      const repo = join(exported.path, 'repository.git');
      assert.equal(git(repo, 'rev-parse', `${exported.commit}^`).trim(), original);
      assert.deepEqual(workGit(repo, ['cat-file', 'commit', original], undefined, false, true), raw);
      assert.equal(git(repo, 'rev-parse', 'refs/heads/side').trim(), side);
      assert.equal(git(repo, 'rev-parse', 'refs/tags/original-tag').trim(), base);
      assert.match(git(repo, 'rev-list', '--parents', head), new RegExp(head + ' [0-9a-f]+ [0-9a-f]+'));
      const clone = join(dir, 'clone');
      git(dir, 'clone', exported.bundle.path, clone);
      assert.equal(readFileSync(join(clone, 'a.ts'), 'utf8'), 'export const a=2;\n');
      assert.deepEqual(readFileSync(join(clone, 'binary.bin')), Buffer.from([0, 255, 128, 10]));
      assert.deepEqual(readFileSync(join(clone, 'new.bin')), Buffer.from([254, 0, 253]));
      assert.ok(
        execFileSync('git', ['-C', clone, 'ls-files', '--stage', 'run.sh'], { encoding: 'utf8' }).startsWith(
          '100755',
        ),
      );
      await assert.rejects(
        exportNativeGit(target, changed, exported.path),
        e => e.code === 'RESTORE_TARGET_EXISTS',
      );
      await assert.rejects(importNativeGit(root, original, target), e => e.code === 'RESTORE_TARGET_EXISTS');
      const bundleId = source.state(imported.head).git.bundle;
      writeFileSync(join(source.directory, bundleId), 'changed');
      await assert.rejects(
        exportNativeGit(target, changed, join(dir, 'corrupt')),
        e => e.code === 'INVALID_NATIVE_SOURCE',
      );
      assert.equal(existsSync(join(dir, 'corrupt')), false);
      assert.equal(git(root, 'status', '--porcelain=v1'), before);
    },
  );
test('native import retains tracked ignored source and symlink targets', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-git-unsupported-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'git');
  mkdirSync(root);
  git(dir, 'init', '--template=', '--initial-branch=main', root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;');
  writeFileSync(join(root, '.gitignore'), 'hidden.ts\n');
  writeFileSync(join(root, 'hidden.ts'), 'tracked ignored source');
  git(root, 'add', '.');
  git(root, 'add', '-f', 'hidden.ts');
  git(root, 'commit', '-m', 'Tracked ignored');
  let head = git(root, 'rev-parse', 'HEAD').trim();
  const imported = await importNativeGit(root, head, join(dir, 'ignored'));
  assert.equal(readFileSync(join(imported.root, 'hidden.ts'), 'utf8'), 'tracked ignored source');
  const w = new WorkService(imported.root),
    intent = w.execute({ action: 'intent', outcome: 'Preserve tracked ignored files' }, 0).result;
  const lane = w.execute(
    { action: 'lane', intentId: intent.id, name: 'Retained' },
    w.status().revision,
  ).result;
  assert.equal(w.status().lanes[0].changes, '');
  writeFileSync(join(w.store.path(lane.id), 'hidden.ts'), 'explicit native edit');
  const selected = w.status().lanes[0];
  const changed = w.execute(
    {
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: selected.head,
      expectedTree: selected.indexTree,
      message: 'Retain original ignored path',
    },
    w.status().revision,
  ).result;
  assert.equal(
    new NativeSource(w.store.root).state(changed.head).files.some(file => file.path === 'hidden.ts'),
    true,
  );
  git(root, 'rm', 'hidden.ts');
  symlinkSync('a.ts', join(root, 'link'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Linked source');
  head = git(root, 'rev-parse', 'HEAD').trim();
  const linked = await importNativeGit(root, head, join(dir, 'linked'));
  assert.equal(
    new NativeSource(linked.root).state(linked.head).files.find(file => file.path === 'link').mode,
    'symlink',
  );
  assert.equal(readFileSync(join(linked.root, 'link'), 'utf8'), 'export const a=1;');
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head);
});

for (const format of ['sha1', 'sha256'])
  test(
    `native ${format} many-State export writes each immutable blob once and preserves every tree/parent`,
    { timeout: 120000 },
    async t => {
      const dir = mkdtempSync(join(tmpdir(), 'forge-native-git-many-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const root = join(dir, 'original');
      mkdirSync(root);
      git(dir, 'init', '--template=', `--object-format=${format}`, '--initial-branch=main', root);
      const unchanged = Buffer.from([0, 255, 128, 10]);
      for (let i = 0; i < 24; i++)
        writeFileSync(join(root, `file-${i}.bin`), Buffer.concat([unchanged, Buffer.from(String(i))]));
      writeFileSync(join(root, 'duplicate.bin'), readFileSync(join(root, 'file-0.bin')));
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'Original many-file base');
      const original = git(root, 'rev-parse', 'HEAD').trim(),
        imported = await importNativeGit(root, original, join(dir, 'native')),
        source = new NativeSource(imported.root);
      const states = [imported.head];
      for (let i = 0; i < 12; i++) {
        const files = source
          .state(states.at(-1))
          .files.map(file =>
            file.path === 'file-1.bin'
              ? { ...file, blob: source.put(Buffer.from(`change-${i}\n`)) }
              : file.path === 'duplicate.bin'
                ? { ...file, mode: i % 2 ? 'file' : 'executable' }
                : file,
          );
        states.push(
          source.writeState(
            files,
            [states.at(-1)],
            `Retained State ${i}`,
            new Date(1700000000000 + i * 1000).toISOString(),
          ),
        );
      }
      const ids = new Set(states.flatMap(id => source.state(id).files.map(file => file.blob))),
        oldWrites = states.reduce((count, id) => count + source.state(id).files.length, 0);
      const bin = join(dir, 'bin'),
        called = join(dir, 'blob-writes');
      mkdirSync(bin);
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\ncase " $* " in *" hash-object -t blob -w --stdin-paths "*) echo blob >> '${called}';; esac\nexec '${realGit}' "$@"\n`,
      );
      chmodSync(join(bin, 'git'), 0o700);
      const priorPath = process.env.PATH;
      let exported;
      try {
        process.env.PATH = bin + ':' + priorPath;
        exported = await exportNativeGit(imported.root, states.at(-1), join(dir, 'projection'));
      } finally {
        process.env.PATH = priorPath;
      }
      assert.equal(readFileSync(called, 'utf8').trim().split('\n').length, 1);
      assert.ok(ids.size > 1);
      assert.ok(oldWrites > ids.size * 8);
      const repo = join(exported.path, 'repository.git'),
        mappings = new Map(exported.states.map(item => [item.state, item.commit]));
      assert.equal(mappings.size, states.length);
      assert.equal(mappings.get(states[0]), original);
      for (let i = 0; i < states.length; i++) {
        const state = source.state(states[i]),
          commit = mappings.get(states[i]);
        const actual = git(repo, 'ls-tree', '-r', commit).trim().split('\n').sort();
        const expected = state.files
          .map(file => {
            const bytes = source.object(file.blob),
              oid = createHash(format)
                .update(Buffer.from(`blob ${bytes.length}\0`))
                .update(bytes)
                .digest('hex');
            return `${file.mode === 'executable' ? '100755' : '100644'} blob ${oid}\t${file.path}`;
          })
          .sort();
        assert.deepEqual(actual, expected);
        if (i) assert.equal(git(repo, 'rev-parse', `${commit}^`).trim(), mappings.get(states[i - 1]));
      }
      assert.deepEqual(
        workGit(repo, ['cat-file', 'blob', `${exported.commit}:file-0.bin`], undefined, false, true),
        Buffer.concat([unchanged, Buffer.from('0')]),
      );
      // A second repository needs its own object writes; previous export IDs are not a global cache.
      const second = await exportNativeGit(imported.root, states.at(-1), join(dir, 'projection-again'));
      assert.equal(second.commit, exported.commit);
      const missing = source.state(states.at(-1)).files[0].blob;
      writeFileSync(join(source.directory, missing), 'corrupt');
      await assert.rejects(
        exportNativeGit(imported.root, states.at(-1), join(dir, 'corrupt')),
        error => error.code === 'INVALID_NATIVE_SOURCE',
      );
      assert.equal(existsSync(join(dir, 'corrupt')), false);
    },
  );
