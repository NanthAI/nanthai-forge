// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original source']);
  const work = new WorkService(root),
    local = command => work.execute(command, work.status().revision).result;
  const intent = local({ action: 'intent', outcome: 'Read original discussion context' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Unfinished approach' });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const data = work.store.load(),
    head = view.head;
  data.intents[0].external = {
    repository: 'tests/example',
    number: 7,
    url: 'https://github.com/tests/example/pull/7',
    author: { id: 1, login: 'original-author' },
    observations: [
      {
        at: '2026-10-01',
        head,
        base: head,
        headRef: 'topic',
        baseRef: 'main',
        title: 'Original PR',
        author: { id: 1, login: 'original-author' },
        prState: 'open',
        merged: false,
        acceptance: 'unconfirmed',
        details: 'Synthetic observed pins',
      },
    ],
  };
  const publicationId = randomUUID();
  data.publications.push({
    id: publicationId,
    viewId: view.id,
    head,
    repository: 'tests/example',
    number: 7,
    base: 'main',
    title: 'Original PR',
    draft: false,
    at: '2026-10-01',
    status: 'published',
  });
  work.store.save(data);
  write(work.store.path(lane.id), 'a.ts', 'Unfinished Lane work');
  const stateFile = join(root, '.git/discussion-api.json'),
    callsFile = join(root, '.git/discussion-calls.log'),
    release = join(root, '.git/discussion-release'),
    ready = join(root, '.git/discussion-ready');
  writeFileSync(
    stateFile,
    JSON.stringify({ head, count: 102, body: '<img src=x onerror=untrusted>\n' + 'é'.repeat(10000) }),
  );
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8')),
    change = patch => writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
  const bin = join(root, '.git/discussion-bin');
  mkdirSync(bin);
  const beforePath = process.env.PATH;
  t.after(() => {
    process.env.PATH = beforePath;
  });
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const state=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8')), endpoint=process.argv[7];
if(process.argv[6]!=='GET') process.exit(9);
appendFileSync(${JSON.stringify(callsFile)},endpoint+'\\n');
if(state.denied) process.exit(1);
if(endpoint==='repos/tests/example/pulls/7') {
 console.log(JSON.stringify({number:state.badPull?8:7,html_url:'https://github.com/tests/example/pull/7',title:'Current PR',user:{id:1,login:'original-author'},state:'open',merged:false,merged_at:null,merge_commit_sha:null,head:{ref:'topic',sha:state.head,repo:{full_name:'tests/example'}},base:{ref:'main',sha:state.head,repo:{full_name:'tests/example'}}}));
} else {
 const match=endpoint.match(/(?:issues|pulls)\\/7\\/(comments|reviews)\\?per_page=100&page=(\\d+)/); if(!match) process.exit(2);
 if(state.hold){writeFileSync(${JSON.stringify(ready)},'ready');while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10));}
 const start=(Number(match[2])-1)*100, count=state.empty?0:match[1]==='reviews'?1:Math.max(0,Math.min(100,state.count-start));
 const rows=Array.from({length:count},(_,i)=>({id:start+i+1,body:state.body,user:i===1?null:{id:1,login:'original-author',extra:'retained'},html_url:'https://github.com/tests/example/pull/7#discussion_r'+(start+i+1),state:match[1]==='reviews'?'CHANGES_REQUESTED':undefined,commit_id:state.head,original_commit_id:'b'.repeat(40),path:'a.ts',line:null,original_line:4,side:'RIGHT',created_at:'2026-10-01T00:00:00Z',provider_extension:{preserved:true}}));
 console.log(JSON.stringify(state.malformed?{}:rows));
}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${beforePath}`;
  const command = (patch = {}) => ({
    action: 'import-discussion',
    operationId: randomUUID(),
    target: { kind: 'intent', id: intent.id },
    feed: 'conversation',
    page: 1,
    ...patch,
  });
  const dispatch = (input, revision = work.status().revision) => work.dispatch(input, revision);
  const read = id => dispatch({ action: 'read-discussion', id }, 0);
  const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').length : 0);
  return {
    root,
    work,
    local,
    lane,
    intent,
    view,
    publicationId,
    command,
    dispatch,
    read,
    calls,
    state,
    change,
    release,
    ready,
  };
}

test('provider pages preserve all original fields privately, keep PR/work pins separate and never alter dirty source or canonical acceptance', async t => {
  const s = setup(t),
    original = git(s.root, ['rev-parse', 'HEAD']).trim(),
    refs = git(s.root, ['for-each-ref']);
  const input = s.command(),
    first = (await s.dispatch(input)).result,
    raw = (await s.read(first.id)).result;
  assert.equal(first.count, 100);
  assert.equal(first.more, true);
  assert.equal(raw.items[0].provider_extension.preserved, true);
  assert.equal(raw.items[1].user, null);
  assert.equal(raw.items[0].body, s.state().body);
  assert.equal(raw.items[0].original_line, 4);
  assert.equal(raw.items[0].line, null);
  assert.equal(statSync(join(s.work.store.directory, `discussion-${first.id}.json`)).mode & 0o777, 0o600);
  assert.ok(
    statSync(join(s.work.store.directory, 'work.json')).size < 10000,
    'Large provider bodies stay outside metadata.',
  );
  const second = (await s.dispatch(s.command({ page: 2 }))).result;
  assert.equal(second.count, 2);
  assert.equal(second.more, false);
  s.change({ head: 'c'.repeat(40) });
  const review = (
    await s.dispatch(s.command({ feed: 'reviews', target: { kind: 'publication', id: s.publicationId } }))
  ).result;
  assert.equal(review.head, original);
  assert.equal(review.providerHead, 'c'.repeat(40));
  assert.equal((await s.read(review.id)).result.items[0].state, 'CHANGES_REQUESTED');
  const inline = (await s.dispatch(s.command({ feed: 'inline' }))).result;
  assert.equal((await s.read(inline.id)).result.items[0].original_commit_id, 'b'.repeat(40));
  const status = s.work.status();
  assert.equal(status.intents[0].external.observations.length, 1);
  assert.equal(status.intents[0].external.observations[0].acceptance, 'unconfirmed');
  assert.equal(status.reviews.length, 0);
  assert.equal(git(s.root, ['for-each-ref']), refs);
  assert.equal(git(s.root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(readFileSync(join(s.work.store.path(s.lane.id), 'a.ts'), 'utf8'), 'Unfinished Lane work');
});

test('unknown publication and concurrent replies reconcile durable pages after revoked access, preserving unrelated notes and later observations', async t => {
  const s = setup(t),
    input = s.command(),
    revision = s.work.status().revision,
    save = s.work.store.save.bind(s.work.store);
  let fail = true;
  s.work.store.save = data => {
    if (fail && data.githubDiscussions.length) {
      fail = false;
      throw new Error('Synthetic publication interruption');
    }
    save(data);
  };
  await assert.rejects(s.dispatch(input), /Synthetic publication interruption/);
  assert.equal(s.work.status().githubDiscussions.length, 0);
  const reads = s.calls();
  s.change({ denied: true });
  const recovered = (await s.dispatch(input, revision)).result;
  assert.equal(s.calls(), reads);
  assert.equal((await s.read(recovered.id)).result.record.id, input.operationId);
  await assert.rejects(s.dispatch({ ...input, page: 2 }, 0), code('EVIDENCE_CHANGED'));
  await assert.rejects(s.dispatch(s.command()), code('PUBLISH_GITHUB_FAILED'));
  assert.equal(s.work.status().githubDiscussions.length, 1);
  s.change({ denied: false, hold: true });
  const next = s.command(),
    oldRevision = s.work.status().revision;
  const pending = Promise.all([s.dispatch(next, oldRevision), s.dispatch(next, oldRevision)]);
  for (let i = 0; i < 400 && !existsSync(s.ready); i++) await new Promise(r => setTimeout(r, 10));
  assert(existsSync(s.ready));
  s.local({ action: 'note', intentId: s.intent.id, kind: 'decision', text: 'Concurrent unrelated decision' });
  writeFileSync(s.release, 'release');
  const results = await pending;
  assert(results.every(r => r.result.id === next.operationId));
  assert.equal(s.work.status().githubDiscussions.length, 2);
  assert.equal(s.work.status().intents[0].notes[0].text, 'Concurrent unrelated decision');
  assert.equal((await s.read(recovered.id)).result.record.id, recovered.id);
});

test('invalid/provider-denied reads preserve history; receipts and exports share CLI/HTTP capability boundaries without GitHub writes', async t => {
  const s = setup(t),
    input = s.command();
  for (const patch of [{ page: 0 }, { page: 1.5 }, { feed: 'execute' }, { operationId: '../unsafe' }])
    await assert.rejects(s.dispatch({ ...input, ...patch }), code('BAD_ARGUMENT'));
  await assert.rejects(s.dispatch(input, 0), code('WORK_STALE'));
  await assert.rejects(
    s.dispatch(s.command({ target: { kind: 'intent', id: randomUUID() } })),
    code('NOT_FOUND'),
  );
  assert.equal(s.calls(), 0);
  s.change({ badPull: true });
  await assert.rejects(s.dispatch(input), code('PUBLICATION_CHANGED'));
  s.change({ badPull: false, malformed: true });
  await assert.rejects(s.dispatch(input), code('INVALID_DISCUSSION'));
  s.change({ malformed: false, empty: true });
  const saved = (await s.dispatch(input)).result;
  assert.equal(saved.count, 0);
  const server = await serveRepository(s.root, 0);
  t.after(() => server.close());
  const body = JSON.stringify({ revision: 0, command: { action: 'export-discussion', id: saved.id } }),
    url = `http://127.0.0.1:${server.port}/api/work`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` };
  assert.equal(
    (await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status,
    401,
  );
  assert.equal(
    (await fetch(url, { method: 'POST', body, headers: { ...headers, Origin: 'https://other.invalid' } }))
      .status,
    403,
  );
  const result = await (await fetch(url, { method: 'POST', body, headers })).json();
  assert.equal(result.result.record.id, saved.id);
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      ['dist/cli.js', 'work', s.root, JSON.stringify({ action: 'export-discussion', id: saved.id }), '0'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(cli.result, result.result);
  const path = join(s.work.store.directory, `discussion-${saved.id}.json`),
    original = readFileSync(path);
  writeFileSync(path, '{');
  await assert.rejects(s.read(saved.id), code('INVALID_DISCUSSION'));
  writeFileSync(path, original);
  unlinkSync(path);
  symlinkSync(join(s.root, 'a.ts'), path);
  await assert.rejects(s.read(saved.id), code('NOT_FOUND'));
  assert.equal(s.work.status().githubDiscussions.length, 1);
});
