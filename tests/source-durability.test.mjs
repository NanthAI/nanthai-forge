// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href;

test(
  'object publication flushes file before rename and directory before return; capture batches directories',
  { skip: process.platform === 'win32' },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    const originalSync=fs.fsyncSync, originalRename=fs.renameSync;
    const events=[];
    fs.fsyncSync=fd=>{events.push(fs.fstatSync(fd).isDirectory()?'directory':'file');originalSync(fd);};
    fs.renameSync=(...args)=>{events.push('rename');return originalRename(...args);};
    syncBuiltinESMExports();
    const {NativeSource}=await import(${JSON.stringify(moduleUrl('native-source'))});
    const root=fs.mkdtempSync(join(tmpdir(),'forge-fsync-order-'));
    try {
      const source=new NativeSource(root);
      source.put(Buffer.from('one'));
      assert.deepEqual(events.slice(-3),['file','rename','directory']);
      events.length=0;
      source.put(Buffer.from('one'));
      assert.deepEqual(events,['directory']);
      for(let i=0;i<12;i++)fs.writeFileSync(join(root,i+'.txt'),'file '+i);
      events.length=0;
      const files=source.capture(root,true);
      assert.equal(events.filter(e=>e==='file').length,12);
      assert.equal(events.filter(e=>e==='directory').length,process.platform==='win32'?0:1);
      assert.equal(events.at(-1),process.platform==='win32'?'rename':'directory');
      let failed=false;
      fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory()){failed=true;throw Error('directory flush fault');}originalSync(fd);};
      syncBuiltinESMExports();
      if(process.platform!=='win32')assert.throws(()=>source.writeState(files,[],'save','now'),/directory flush fault/);
      if(process.platform!=='win32')assert.equal(failed,true);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  `,
      ],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
  },
);

test('Windows keeps recorded executable modes and flushes through writable handles (89460350)', async t => {
  const { regularFileMode, executableBitMatches, gitFileMode } = await import(moduleUrl('file-mode'));
  // Windows stores no executable bit: the recorded mode carries over, a new file is plain.
  assert.equal(regularFileMode(0o666, 'executable', 'win32'), 'executable');
  assert.equal(regularFileMode(0o666, 'file', 'win32'), 'file');
  assert.equal(regularFileMode(0o666, undefined, 'win32'), 'file');
  assert.equal(executableBitMatches(0o666, 'executable', 'win32'), true);
  assert.equal(gitFileMode(0o666, '100755', 'win32'), '100755');
  // macOS and Linux read the bit from disk, so a chmod is a real change.
  assert.equal(regularFileMode(0o644, 'executable', 'linux'), 'file');
  assert.equal(regularFileMode(0o755, 'file', 'darwin'), 'executable');
  assert.equal(executableBitMatches(0o644, 'executable', 'linux'), false);
  assert.equal(gitFileMode(0o755, '100644', 'linux'), '100755');

  const { fileFlushFlags, syncFile, syncDirectory } = await import(moduleUrl('native-durability'));
  assert.equal(fileFlushFlags(), process.platform === 'win32' ? 'r+' : 'r');
  const directory = mkdtempSync(join(tmpdir(), 'forge-flush-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'file.txt'), 'bytes\n');
  syncFile(join(directory, 'file.txt'));
  syncDirectory(directory);
});

test('Windows without link rights writes a source link as its target file and reads it back (89460350)', async t => {
  const { writeSourceLink, diskMode, diskShapeMatches, linkFallback } = await import(
    moduleUrl('source-links')
  );
  const { ownerOnly } = await import(moduleUrl('file-mode'));
  const directory = mkdtempSync(join(tmpdir(), 'forge-link-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = fs.symlinkSync;
  fs.symlinkSync = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
  };
  syncBuiltinESMExports();
  try {
    assert.equal(writeSourceLink('target.txt', join(directory, 'link'), 'win32'), false);
    assert.equal(readFileSync(join(directory, 'link'), 'utf8'), 'target.txt');
    // Elsewhere a refused link is a real failure, never a silent file.
    assert.throws(() => writeSourceLink('target.txt', join(directory, 'other'), 'linux'), { code: 'EPERM' });
  } finally {
    fs.symlinkSync = original;
    syncBuiltinESMExports();
  }
  const file = fs.lstatSync(join(directory, 'link'));
  assert.equal(linkFallback(file, 'symlink', 'win32'), true);
  assert.equal(diskMode(file, 'symlink', 'win32'), 'symlink');
  assert.equal(diskShapeMatches(file, 'symlink', 'win32'), true);
  // On macOS and Linux a file where a link was recorded is a real change.
  assert.equal(diskMode(file, 'symlink', 'linux'), 'file');
  assert.equal(diskShapeMatches(file, 'symlink', 'darwin'), false);
  // A submodule kept as its pointer file matches its gitlink record, as before the helper.
  assert.equal(diskShapeMatches(file, 'gitlink', 'linux'), true);
  assert.equal(diskShapeMatches(file, 'gitlink', 'win32'), true);
  assert.equal(ownerOnly(0o666, 'win32'), true);
  assert.equal(ownerOnly(0o644, 'linux'), false);
  assert.equal(ownerOnly(0o600, 'linux'), true);
});
