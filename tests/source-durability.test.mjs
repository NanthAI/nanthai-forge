// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { agentSync, syncWorkspace } from '../dist/agent-sync.js';

const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href;
function kill(code, data) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, F3_DATA: JSON.stringify(data) },
    encoding: 'utf8',
  });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-durability-'));
  writeFileSync(join(root, 'a.txt'), 'original');
  writeFileSync(join(root, 'b.txt'), 'old');
  initNative(root);
  return { root, source: new NativeSource(root), agent: new AgentWorkflow(root) };
}
for (const phase of [
  'afterPlan',
  'beforeWorkspace',
  'afterRemove',
  'duringWrite',
  'afterReplace',
  'afterWorkspace',
]) {
  test(`sync resumes after SIGKILL at ${phase}, including file/directory transitions`, async () => {
    const { root, source, agent } = fixture();
    try {
      const lane = (await agent.dispatch({ action: 'start', outcome: 'durability' })).result;
      const from = source.state(lane.head).files;
      const to = [
        { path: 'a.txt/child.txt', blob: source.put(Buffer.from('child')), mode: 'file' },
        { path: 'b.txt', blob: source.put(Buffer.from('complete replacement')), mode: 'executable' },
      ];
      kill(
        `
        import { NativeSource } from ${JSON.stringify(moduleUrl('native-source'))};
        import { syncWorkspace, syncTestHooks } from ${JSON.stringify(moduleUrl('agent-sync'))};
        import { writeFileSync } from 'node:fs';
        const d=JSON.parse(process.env.F3_DATA);
        let count=0; syncTestHooks[d.phase]=(fd)=>{ if(['duringWrite','afterReplace'].includes(d.phase) && ++count < 2)return; if(d.phase==='duringWrite')writeFileSync(fd,'partial');process.kill(process.pid,'SIGKILL'); };
        syncWorkspace(new NativeSource(d.root),d.path,d.head,d.from,d.to);
      `,
        { root, path: lane.path, head: lane.head, from, to, phase },
      );
      if (phase === 'duringWrite') assert.equal(readFileSync(join(lane.path, 'b.txt'), 'utf8'), 'old');
      syncWorkspace(source, lane.path, lane.head, from, to);
      syncWorkspace(source, lane.path, lane.head, from, to);
      assert.equal(source.tree(source.capture(lane.path, false, lane.head)), source.tree(to));
      assert.equal(readFileSync(join(lane.path, 'b.txt'), 'utf8'), 'complete replacement');
      // Reverse transition must also resume with its parent directory removed.
      syncWorkspace(source, lane.path, lane.head, to, from);
      assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'original');
      writeFileSync(join(lane.path, 'b.txt'), 'unrelated edit');
      assert.throws(() => syncWorkspace(source, lane.path, lane.head, from, to), { code: 'LANE_DIRTY' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
for (const phase of ['file', 'beforePublish', 'afterRename', 'afterPublish']) {
  test(`Lane start replays its operation after SIGKILL at ${phase}`, async () => {
    const { root, agent } = fixture();
    try {
      const request = { action: 'start', operationId: randomUUID(), outcome: 'staged create' };
      kill(
        `
        import { AgentWorkflow } from ${JSON.stringify(moduleUrl('agent-workflow'))};
        import { nativeSourceTestHooks } from ${JSON.stringify(moduleUrl('native-source'))};
        import { NativeWorkspaceFiles } from ${JSON.stringify(moduleUrl('native-workspace-files'))};
        const d=JSON.parse(process.env.F3_DATA);
        const stop=()=>process.kill(process.pid,'SIGKILL');
        if(d.phase==='file') {const original=NativeWorkspaceFiles.prototype.write; NativeWorkspaceFiles.prototype.write=function(...args){original.apply(this,args);stop();};}
        else nativeSourceTestHooks[d.phase]=stop;
        await new AgentWorkflow(d.root).dispatch(d.request);
      `,
        { root, request, phase },
      );
      const lanes = agent.work.store.load().lanes;
      assert.equal(lanes.length, 1);
      const path = agent.work.store.path(lanes[0].id);
      assert.equal(existsSync(path), ['afterRename', 'afterPublish'].includes(phase));
      const staged = readdirSync(join(root, '.forge/work')).find(n => n.startsWith('.lane-stage-'));
      if (staged) writeFileSync(join(root, '.forge/work', staged, 'unsaved-work.txt'), 'keep staging edits');
      const first = (await agent.dispatch(request)).result;
      const second = (await agent.dispatch(request)).result;
      assert.equal(first.laneId, second.laneId);
      if (staged)
        assert.equal(
          readFileSync(join(root, '.forge/work', staged, 'unsaved-work.txt'), 'utf8'),
          'keep staging edits',
        );
      assert.equal(readFileSync(join(first.path, 'a.txt'), 'utf8'), 'original');
      assert.equal(agent.work.store.load().lanes.length, 1);
      // Interrupted staging bytes are retained, including any possible edits.
      if (!['afterRename', 'afterPublish'].includes(phase))
        assert.ok(readdirSync(join(root, '.forge/work')).some(n => n.startsWith('.lane-stage-')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('sync retry keeps its pinned target even when the requested current target advances', async () => {
  const { root, source, agent } = fixture();
  try {
    const lane = (await agent.dispatch({ action: 'start', outcome: 'pin' })).result;
    const from = source.state(lane.head).files;
    const side = source.writeState(from, [lane.head], 'side branch', 'now');
    const make = text =>
      source.writeState(
        from.map(f => (f.path === 'b.txt' ? { ...f, blob: source.put(Buffer.from(text)) } : f)),
        [lane.head, side],
        text,
        'now',
      );
    const target = make('first'),
      later = make('later');
    const command = {
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      channel: 'main',
    };
    kill(
      `
      import { AgentWorkflow } from ${JSON.stringify(moduleUrl('agent-workflow'))};
      import { agentSync, syncTestHooks } from ${JSON.stringify(moduleUrl('agent-sync'))};
      const d=JSON.parse(process.env.F3_DATA); syncTestHooks.afterReplace=()=>process.kill(process.pid,'SIGKILL');
      agentSync(new AgentWorkflow(d.root).work.store,d.command,{target:d.target});
    `,
      { root, command, target },
    );
    const selection = readFileSync(join(lane.path, '.forge', `sync-${command.operationId}.json`));
    assert.throws(
      () =>
        agentSync(
          agent.work.store,
          { ...command, operationId: randomUUID(), channel: 'another' },
          { target: later },
        ),
      { code: 'LANE_DIRTY' },
    );
    assert.equal(
      readFileSync(join(lane.path, '.forge', `sync-${command.operationId}.json`)).equals(selection),
      true,
    );
    const result = agentSync(agent.work.store, command, { target: later }).result;
    assert.equal(result.target, target);
    assert.equal(readFileSync(join(lane.path, 'b.txt'), 'utf8'), 'first');
    const replay = agentSync(agent.work.store, command, { target: later }).result;
    assert.equal(replay.head, result.head);
    assert.equal(replay.target, target);
    // Simulate a crash after Work publication but before selection cleanup.
    writeFileSync(join(lane.path, '.forge', `sync-${command.operationId}.json`), selection);
    await agent.dispatch({ action: 'undo-sync', laneId: lane.laneId, syncOperationId: command.operationId });
    const next = agentSync(
      agent.work.store,
      { ...command, operationId: randomUUID() },
      { target: later },
    ).result;
    assert.equal(next.target, later);
    assert.equal(readFileSync(join(lane.path, 'b.txt'), 'utf8'), 'later');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('sync preserves an unrelated ignored destination and recognises a planned ignored file on replay', async () => {
  const { root, source, agent } = fixture();
  try {
    const lane = (await agent.dispatch({ action: 'start', outcome: 'ignored files' })).result;
    const from = source.state(lane.head).files;
    writeFileSync(join(lane.path, '.gitignore'), 'ignored.txt\n');
    const ignore = { path: '.gitignore', blob: source.put(Buffer.from('ignored.txt\n')), mode: 'file' };
    const before = [...from, ignore].sort((a, b) => a.path.localeCompare(b.path));
    const to = [...before, { path: 'ignored.txt', blob: source.put(Buffer.from('planned')), mode: 'file' }];
    writeFileSync(join(lane.path, 'ignored.txt'), 'unrelated');
    assert.throws(() => syncWorkspace(source, lane.path, lane.head, before, to), { code: 'LANE_DIRTY' });
    assert.equal(readFileSync(join(lane.path, 'ignored.txt'), 'utf8'), 'unrelated');
    rmSync(join(lane.path, 'ignored.txt'));
    syncWorkspace(source, lane.path, lane.head, before, to);
    syncWorkspace(source, lane.path, lane.head, before, to);
    assert.equal(readFileSync(join(lane.path, 'ignored.txt'), 'utf8'), 'planned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint rejects a failed object-directory flush and the original operation retries safely', async () => {
  const { root, source, agent } = fixture();
  const original = fs.fsyncSync;
  try {
    const lane = (await agent.dispatch({ action: 'start', outcome: 'flush failure' })).result;
    const directory = fs.statSync(source.directory);
    writeFileSync(join(lane.path, 'a.txt'), 'new checkpoint');
    const request = {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      message: 'durable save',
      expectedHead: lane.head,
    };
    fs.fsyncSync = fd => {
      const found = fs.fstatSync(fd);
      if (found.isDirectory() && found.ino === directory.ino && found.dev === directory.dev)
        throw Error('object directory flush fault');
      return original(fd);
    };
    syncBuiltinESMExports();
    await assert.rejects(agent.dispatch(request), /object directory flush fault/);
    assert.equal(agent.work.store.load().lanes[0].head, lane.head);
    fs.fsyncSync = original;
    syncBuiltinESMExports();
    const saved = (await agent.dispatch(request)).result;
    assert.notEqual(saved.head, lane.head);
    assert.equal((await agent.dispatch(request)).result.head, saved.head);
    assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'new checkpoint');
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
