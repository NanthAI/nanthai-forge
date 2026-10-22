// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { fixture, git, write } from './helpers.mjs';

function writeState(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

export function setup(t, options = {}) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic initial source']);
  git(root, ['branch', '-M', 'main']);
  const remote = join(root, '.git', 'test-remote');
  git(root, ['clone', '--bare', root, remote]);
  const work = new WorkService(root);
  const local = command => work.execute(command, work.status().revision).result;
  const intent = local({ action: 'intent', outcome: 'Publish synthetic change' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const checkpoint = text => {
    const path = work.store.path(lane.id);
    write(path, 'a.ts', text);
    git(path, ['add', 'a.ts']);
    const state = work.status().lanes[0];
    return local({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: state.actualHead,
      expectedTree: state.indexTree,
      message: 'Synthetic change',
    });
  };
  const head = checkpoint('export const a = 2;\n').head;
  const view = local({ action: 'compose', intentId: intent.id, inputs: [{ laneId: lane.id, head }] });
  const command = {
    action: 'publish',
    operationId: randomUUID(),
    viewId: view.id,
    expectedHead: head,
    repository: 'tests/example',
    base: '',
    title: intent.outcome,
    draft: false,
  };
  const stateFile = join(root, '.git', 'api.json');
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const change = patch => writeState(stateFile, { ...state(), ...patch });
  writeState(stateFile, { pulls: [], creates: 0, ...options });
  const bin = join(root, '.git', 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const pathBefore = process.env.PATH;
  t.after(() => {
    process.env.PATH = pathBefore;
  });
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
${writeState.toString()}
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2).map(a => a === 'https://github.com/tests/example.git' ? ${JSON.stringify(remote)} : a);
// Batch protocols answer requests before EOF; never buffer their duplex pipes.
if (args.includes('--stdin-paths') || (args.includes('mktree') && args.includes('--batch'))) {
  const child = spawn(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
  child.on('error', () => process.exit(1));
  const code = await new Promise(resolve => child.on('close', resolve));
  process.exit(code ?? 1);
}
try {
  const before = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (args.includes('push') && before.mirrorRace) {
    before.mirrorRace = false; writeState(stateFile, before);
    execFileSync(${JSON.stringify(realGit)}, ['--git-dir', ${JSON.stringify(remote)}, 'update-ref', before.raceRef, before.raceHead]);
  }
  const out = execFileSync(${JSON.stringify(realGit)}, args, { input: readFileSync(0), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (args.includes('push') && state.lostPush) { state.lostPush = false; writeState(stateFile, state); process.exit(1); }
  if (args.includes('ls-remote') && state.holdMirror) {
    state.holdMirror = false; state.mirrorStarted = true; writeState(stateFile, state);
    while (!JSON.parse(readFileSync(stateFile, 'utf8')).releaseMirror) await new Promise(resolve => setTimeout(resolve, 20));
  }
  process.stdout.write(out);
} catch (e) { if (e.stdout) process.stdout.write(e.stdout); process.exit(e.status || 1); }
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
${writeState.toString()}
const stateFile = ${JSON.stringify(stateFile)}, state = JSON.parse(readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2), path = args[5], method = args[4];
let result;
if (path === 'repos/tests/example') result = { id: state.repositoryId ?? 77, full_name: 'tests/example', default_branch: 'main', permissions: { push: state.writePermission ?? !state.denied } };
else if (path.startsWith('repos/tests/example/commits/')) {
  if (state.deniedRead) process.exit(1);
  result = {total_count:1,check_runs:[{id:1,name:'Projection CI',head_sha:state.checkHead??path.split('/')[4],status:'completed',conclusion:'success',html_url:null,started_at:null,completed_at:null,app:null}]};
}
else if (path.startsWith('repos/tests/example/pulls?')) result = state.pulls;
else if (path.startsWith('repos/tests/example/issues/7/comments?')) {
  if (state.deniedRead) process.exit(1);
  result = [{id:1,user:{id:101,login:'upstream-author'},body:'Original private provider comment',provider_extension:{retained:true}}];
}
else if (path === 'repos/tests/example/pulls/7') {
  if (state.deniedRead) process.exit(1);
  result = state.pulls[0];
  if (state.holdDetail) {
    state.holdDetail = false; state.delayStarted = true; writeState(stateFile, state);
    while (!JSON.parse(readFileSync(stateFile, 'utf8')).releaseDetail) await new Promise(resolve => setTimeout(resolve, 20));
  }
}

else if (path === 'repos/tests/example/pulls' && method === 'POST') {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (state.failCreate || state.pulls.some(p => p.head.ref === input.head)) process.exit(1);
  const sha = execFileSync(${JSON.stringify(realGit)}, ['--git-dir', ${JSON.stringify(remote)}, 'rev-parse', 'refs/heads/' + input.head], { encoding: 'utf8' }).trim();
  result = { number: 7, html_url: 'https://github.com/tests/example/pull/7', state: 'open', merged: false, merged_at: null, merge_commit_sha: null, title: input.title, user: { id: 101, login: 'upstream-author' }, draft: input.draft, body: input.body,
    head: { ref: input.head, sha, repo: { full_name: 'tests/example' } }, base: { ref: input.base, sha: execFileSync(${JSON.stringify(realGit)}, ['--git-dir', ${JSON.stringify(remote)}, 'rev-parse', 'refs/heads/' + input.base], { encoding: 'utf8' }).trim(), repo: { full_name: 'tests/example' } } };
  execFileSync(${JSON.stringify(realGit)}, ['--git-dir', ${JSON.stringify(remote)}, 'update-ref', 'refs/pull/7/head', sha]);
  state.pulls.push(result); state.creates++; writeState(stateFile, state);
  if (state.lostCreate) process.exit(1);
} else process.exit(1);
process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${pathBefore}`;
  const publish = (input = command, revision = work.status().revision) => work.dispatch(input, revision);
  return { root, remote, work, local, lane, intent, view, command, state, change, checkpoint, publish };
}
