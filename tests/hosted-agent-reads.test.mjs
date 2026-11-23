// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { digest } from '../dist/hash.js';
import { showHostedSource } from '../dist/mcp-hosted-source.js';
import { hostedShowCli } from '../dist/hosted-show-cli.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { getFunctionName } from 'convex/server';
function fixture(t, count = 3) {
  const f = agentFixture(t);
  const put = bytes => {
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  const state = version =>
    put(
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: Array.from({ length: count }, (_, i) => ({
            path: `src/${String(i).padStart(5, '0')}.ts`,
            blob: put(Buffer.from(`export const value${i} = '${version}';\n`.repeat(40))),
            mode: 'file',
          })),
          at: '2026-01-01T00:00:00.000Z',
          message: 'Synthetic',
        }),
      ),
    );
  f.lane.base.head = state('base');
  f.lane.head = state('saved');
  f.candidate.result.head = f.lane.head;
  return f;
}
for (const count of [3000, 29000])
  test(`${count}-file hosted CLI diff is pinned, bounded and page-batched`, async t => {
    const f = fixture(t, count),
      transport = f.transport();
    const command = { laneId: f.lane.laneId, byteBudget: 4096 };
    const started = performance.now(),
      beforeRss = process.memoryUsage().rss;
    const response = await hostedAgentCli(f.root, 'diff', command, f.address, transport);
    const result = response.result;
    const extraRss = process.memoryUsage().rss - beforeRss;
    assert(extraRss < 256 * 1024 * 1024, `bounded manifest/source working memory: ${extraRss}`);
    t.diagnostic(
      `diff ${count}: ${(performance.now() - started).toFixed(1)} ms, ${extraRss} additional RSS bytes`,
    );
    assert.equal(result.head, f.lane.head);
    assert.equal(result.base, f.lane.base.head);
    assert.equal(result.total, count);
    assert(result.nextCursor && result.truncated);
    // ad80e037: a page that is not the last says so and gives the next-page command.
    assert.match(
      result.more,
      new RegExp(
        `^This page shows changed paths 1-${result.nextCursor.offset} of ${count}; more pages follow\\. Next page: nforge agent `,
      ),
    );
    assert.deepEqual(result.next.cursor, result.nextCursor);
    assert.equal(result.next.action, 'diff');
    assert(result.command.includes(' diff ') && result.more.endsWith(result.command));
    assert(result.items.length > 0);
    assert(result.items.some(item => item.hunks?.length));
    assert(result.cost.sourceBytes <= command.byteBudget);
    assert(result.cost.outputBytes <= command.byteBudget);
    assert.equal(f.calls.filter(c => c.name === 'projectHostedLanes:select').length, 2);
    const pages = f.calls.filter(c => c.name === 'projectObjectDownloads:lanePage');
    assert.equal(pages.length, 2, 'one State pair page and one selected blob metadata page');
    assert(pages.every(c => c.args.digests.length <= 100));
    assert(
      f.calls.every(c => ['projectHostedLanes:select', 'projectObjectDownloads:lanePage'].includes(c.name)),
    );
    const pinned = result.head;
    f.lane.head = f.lane.base.head;
    const { action: _diff, ...nextInput } = result.next;
    const continued = await transport.dispatch('diff', nextInput);
    assert.equal(continued.result.head, pinned, 'a save cannot substitute new source into continuation');
    assert.equal(
      continued.result.items[0].path,
      `src/${String(result.nextCursor.offset).padStart(5, '0')}.ts`,
    );
    f.allow(false);
    await assert.rejects(transport.dispatch('diff', command), e => e.code === 'PROJECT_UNAVAILABLE');
    t.diagnostic(
      `${count}: ${result.cost.manifestBytes} manifest bytes; ${result.cost.sourceBytes} selected source bytes; ${pages.length} metadata pages`,
    );
  });
test('saved CLI and MCP return small hunks from large files within the reply budget (c4a16f44)', async t => {
  const base = {},
    lane = {};
  for (const [index, size] of [78_500, 102_500, 125_000].entries()) {
    const path = `large-${index}.txt`;
    const stable = 'unchanged saved source\n'.repeat(Math.floor(size / 23));
    base[path] = `before ${index}\n${stable}`;
    lane[path] = base[path].replace(`before ${index}`, `after ${index}`);
    if (index === 0) {
      base[path] += 'removed at end\n';
      lane[path] += 'added at end\nnew final line\n';
    }
  }
  const f = agentFixture(t, { base, lane }),
    transport = f.transport();
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow({ registerTool: (name, _options, call) => tools.set(name, call) }, transport),
  );
  const command = { laneId: f.lane.laneId, byteBudget: 100_000 };
  const cli = (await hostedAgentCli(f.root, 'diff', command, f.address, transport)).result;
  const reply = await tools.get('forge_review')({ command: { action: 'diff', ...command } });
  const mcp = JSON.parse(reply.content[0].text).result;
  const sourceBytes = [...Object.values(base), ...Object.values(lane)].reduce(
    (sum, value) => sum + Buffer.byteLength(value),
    0,
  );
  for (const result of [cli, mcp]) {
    assert.deepEqual(result.omitted, []);
    assert.equal(result.nextCursor, null);
    assert.equal(result.truncated, false);
    assert.equal(result.cost.sourceBytes, sourceBytes);
    assert(result.cost.outputBytes < 3000);
    assert.equal(result.cost.metadataPages, 1);
    assert.deepEqual(
      result.items.map(item =>
        item.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'context').map(line => line.text)),
      ),
      [
        ['before 0', 'after 0', 'removed at end', 'added at end', 'new final line'],
        ['before 1', 'after 1'],
        ['before 2', 'after 2'],
      ],
    );
    assert.deepEqual(
      result.items[0].hunks.map(hunk => hunk.beforeStart),
      [1, Math.floor(78_500 / 23) - 1],
    );
  }
  const pages = f.calls.filter(call => call.name === 'projectObjectDownloads:lanePage');
  assert(pages.every(call => call.args.digests.length <= 100));
  assert.equal(pages.filter(call => call.args.digests.length === 6).length, 2);
  t.diagnostic(
    `Large-file page: ${cli.cost.manifestBytes} manifest B, ${sourceBytes} selected source B, ${cli.cost.downloadedBytes} cold download B, ${mcp.cost.downloadedBytes} repeated download B, ${cli.cost.outputBytes} hunk B`,
  );
});
test('a full hunk continues on the original saved pair when an earlier file fills the reply', async t => {
  const line = letter => letter.repeat(370);
  const stable = 'unchanged\n'.repeat(8200);
  const f = agentFixture(t, {
    base: {
      'a.txt': `${line('a')}\n${stable}`,
      'b.txt': `${line('b')}\n${stable}`,
      'c.txt': `${line('e')}\n${stable}`,
    },
    lane: {
      'a.txt': `${line('c')}\n${stable}`,
      'b.txt': `${line('d')}\n${stable}`,
      'c.txt': `${line('f')}\n${stable}`,
    },
  });
  const transport = f.transport(),
    command = { laneId: f.lane.laneId, byteBudget: 1024 };
  const { result: first } = await transport.dispatch('diff', command);
  assert.deepEqual(
    first.items.map(item => item.path),
    ['a.txt'],
  );
  assert.equal(first.items[0].truncated, false);
  assert(first.cost.outputBytes <= command.byteBudget);
  assert.equal(first.nextCursor.offset, 1);
  const { result: repeated } = await transport.dispatch('diff', command);
  assert.equal(repeated.cost.downloadedBytes, 0);
  assert.equal(repeated.cost.sourceBytes, 4 * (371 + stable.length), 'the third pair stays unread');
  f.lane.head = f.lane.base.head;
  const { result: second } = await transport.dispatch('diff', { ...command, cursor: first.nextCursor });
  assert.equal(second.head, first.head);
  assert.equal(second.base, first.base);
  assert.deepEqual(
    second.items.map(item => item.path),
    ['b.txt'],
  );
  assert.deepEqual(
    second.items[0].hunks.flatMap(hunk => hunk.lines.filter(change => change.kind !== 'context')),
    [
      { kind: 'removed', text: line('b') },
      { kind: 'added', text: line('d') },
    ],
  );
  assert(second.cost.outputBytes <= command.byteBudget);
  assert.equal(second.nextCursor.offset, 2);
  f.allow(false);
  await assert.rejects(
    transport.dispatch('diff', { ...command, cursor: second.nextCursor }),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
});
test('diff discloses a changed line that cannot fit and reports the budget needed for the hunk', async t => {
  const f = agentFixture(t, {
    base: { 'row.txt': 'a'.repeat(1400) },
    lane: { 'row.txt': 'b'.repeat(1400) },
  });
  const transport = f.transport(),
    command = { laneId: f.lane.laneId, byteBudget: 1024 };
  const { result: first } = await transport.dispatch('diff', command);
  const [item] = first.items;
  assert.deepEqual(item.hunks, []);
  assert.equal(item.truncated, true);
  assert(item.requiredByteBudget > command.byteBudget);
  assert(first.cost.outputBytes <= command.byteBudget);
  const { result: full } = await transport.dispatch('diff', {
    ...command,
    byteBudget: item.requiredByteBudget,
  });
  assert.equal(full.truncated, false);
  assert.equal(full.items[0].hunks[0].lines.length, 2);
});
test('diff reports a file beyond the text comparison bound without reading its blob', async t => {
  const f = agentFixture(t, { lane: { 'huge.txt': 'x'.repeat(1024 * 1024 + 1) } });
  const result = (await f.transport().dispatch('diff', { laneId: f.lane.laneId, byteBudget: 1024 })).result;
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.omitted, [
    { path: 'huge.txt', reason: 'source-too-large', sourceBytes: 1024 * 1024 + 1 },
  ]);
  assert.equal(result.truncated, true);
  assert.equal(result.cost.sourceBytes, 0);
});
test('CLI and MCP show exact Candidate/State bytes, with no revision substitution and fresh access on cache hits', async t => {
  const f = fixture(t, 1),
    transport = f.transport(),
    state = f.lane.head;
  const selected = { state, path: 'src/00000.ts' };
  const first = await showHostedSource(transport, { ...selected, action: 'show' });
  assert.equal(first.result.state, state);
  assert.match(first.result.content, /saved/);
  f.lane.head = f.lane.base.head;
  const second = await showHostedSource(transport, { ...selected, action: 'show' });
  assert.equal(second.result.content, first.result.content);
  let stdout;
  await hostedShowCli(
    f.root,
    { candidateId: f.candidate.id, path: selected.path },
    f.address,
    transport,
    b => {
      stdout = b.toString();
    },
  );
  assert.equal(stdout, first.result.content);
  const tools = new Map();
  const close = registerHostedAgentWorkflow(
    {
      registerTool(name, options, call) {
        tools.set(name, { ...options, call });
      },
    },
    transport,
  );
  t.after(close);
  const reply = await tools.get('forge_review').call({ command: { action: 'show', ...selected } });
  assert.equal(JSON.parse(reply.content[0].text).result.state, state);
  assert(
    tools.get('forge_review').inputSchema.command.safeParse({ action: 'diff', laneId: f.lane.laneId })
      .success,
  );
  assert(
    tools
      .get('forge_review')
      .inputSchema.command.safeParse({ action: 'peers', laneId: f.lane.laneId, path: selected.path }).success,
  );
  const descriptions = [...tools.values()].reduce((n, tool) => n + tool.description.length, 0);
  assert(descriptions <= 2400, `total description characters: ${descriptions}`);
  f.allow(false);
  await assert.rejects(
    showHostedSource(transport, { ...selected, action: 'show' }),
    e => e.code === 'PROJECT_UNAVAILABLE',
  );
  f.allow(true);
  await assert.rejects(
    showHostedSource(transport, { action: 'show', state: 'a'.repeat(64), path: selected.path }),
    e => e.code === 'SOURCE_UNAVAILABLE',
  );
});

test('invalid hosted read parameters fail with a structured error before any server call', async t => {
  const f = fixture(t, 1),
    transport = f.transport();
  for (const [action, command] of [
    ['diff', { byteBudget: 0 }],
    ['diff', { unknown: 'private' }],
    ['peers', { path: '../outside' }],
    ['peers', { detail: 'yes' }],
  ])
    await assert.rejects(transport.dispatch(action, command), error => error.code === 'BAD_ARGUMENT');
  assert.equal(f.calls.length, 0);
});
test('diff from a short saved State id compares that save with the head; ambiguity and misses are refused (Issue 17ea21ac)', async t => {
  const f = fixture(t, 1);
  const put = bytes => {
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  const blob = put(Buffer.from("export const value0 = 'older';\n"));
  const older = put(
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [{ path: 'src/00000.ts', blob, mode: 'file' }],
        at: '2026-01-01T00:00:00.000Z',
        message: 'Older save',
      }),
    ),
  );
  // The Lane's save history (records saves), as the server lists it: each save with its State.
  let heads = [older, f.lane.head],
    recordReads = 0;
  const query = f.exchange.client.query;
  f.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedRecordReads:read') return query(ref, args);
    recordReads++;
    assert.deepEqual(JSON.parse(args.request), {
      collection: 'saves',
      parentId: f.lane.laneId,
      cursor: null,
    });
    return JSON.stringify({
      collection: 'saves',
      items: heads.map((head, version) => ({ id: f.lane.laneId, kind: 'save', version, head })),
      nextCursor: null,
    });
  };
  const transport = f.transport();
  const short = (await transport.dispatch('diff', { laneId: f.lane.laneId, from: older.slice(0, 8) })).result;
  assert.equal(recordReads, 1, 'one save-history page');
  assert.equal(short.base, older);
  assert.equal(short.head, f.lane.head);
  assert.equal(short.items.length, 1);
  assert.match(JSON.stringify(short.items[0]), /older/);
  const full = (await transport.dispatch('diff', { laneId: f.lane.laneId, from: older.toUpperCase() }))
    .result;
  assert.equal(full.base, older);
  assert.equal(recordReads, 1, 'a full State id needs no save-history read');
  heads = [older, `${older.slice(0, 10)}${'0'.repeat(54)}`];
  await assert.rejects(transport.dispatch('diff', { laneId: f.lane.laneId, from: older.slice(0, 8) }), e => {
    assert.equal(e.code, 'AMBIGUOUS_ID');
    return true;
  });
  const miss = [...'0123456789abcdef'].find(
    c => ![older, f.lane.head, f.lane.base.head].some(s => s[0] === c),
  );
  await assert.rejects(transport.dispatch('diff', { laneId: f.lane.laneId, from: miss.repeat(8) }), e => {
    assert.equal(e.code, 'NOT_FOUND');
    assert.match(e.message, /records/);
    return true;
  });
  await assert.rejects(
    transport.dispatch('diff', { laneId: f.lane.laneId, from: older.slice(0, 7) }),
    e => e.code === 'BAD_ARGUMENT',
  );
});

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function readTree(root, base = root) {
  const out = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    const rel = base === root ? entry.name : `${root.slice(base.length + 1)}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, readTree(full, base));
    else out[rel] = readFileSync(full);
  }
  return out;
}

function assertWholeHunks(diffText) {
  const lines = diffText.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.startsWith('@@ ')) {
      i++;
      continue;
    }
    const match = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(line);
    assert(match, `valid unified hunk header: ${line}`);
    let expectedBefore = Number(match[1]),
      expectedAfter = Number(match[2]),
      seenBefore = 0,
      seenAfter = 0;
    i++;
    while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
      const current = lines[i++];
      if (current === '\\ No newline at end of file') continue;
      if (current.startsWith(' ')) {
        seenBefore++;
        seenAfter++;
      } else if (current.startsWith('-')) {
        seenBefore++;
      } else if (current.startsWith('+')) {
        seenAfter++;
      } else {
        assert.fail(`unexpected line inside hunk: ${current}`);
      }
    }
    assert.equal(seenBefore, expectedBefore, `hunk before-line count intact (${line})`);
    assert.equal(seenAfter, expectedAfter, `hunk after-line count intact (${line})`);
  }
}

test('Issue a37a53d3: diff format:"unified" from inside a Lane covers add, delete, edit, rename, no-newline and binary files and applies with patch -p1', async t => {
  const baseText = {
    'src/deleted.ts': 'export const gone = true;\nexport const second = 2;\n',
    'src/edited.ts': 'line 1\nline 2 old\nline 3\nline 4\n',
    'src/old-name.ts': 'export const moved = "renamed";\n',
    'src/no-newline.txt': 'first line\nwithout trailing newline old',
    'src/newline-removed.txt': 'keep 1\nlast line\n',
    'src/newline-added.txt': 'keep 1\nlast line',
  };
  const headText = {
    'src/added.ts': 'export const added = 1;\nexport const next = 2;\n',
    'src/edited.ts': 'line 1\nline 2 new\nline 3\nline 4\n',
    'src/new-name.ts': 'export const moved = "renamed";\n',
    'src/no-newline.txt': 'first line\nwithout trailing newline new',
    'src/newline-removed.txt': 'keep 1\nlast line',
    'src/newline-added.txt': 'keep 1\nlast line\n',
  };
  const f = agentFixture(t, {
    base: {
      ...baseText,
      'assets/logo.bin': '\x00\x01\x02base',
      'assets/latin1.txt': Buffer.from('caf\xe9 old\n', 'latin1'),
    },
    lane: {
      ...headText,
      'assets/logo.bin': '\x00\x01\x03head',
      'assets/latin1.txt': Buffer.from('caf\xe9 new\n', 'latin1'),
    },
  });
  const transport = f.transport();
  // Open the Lane checkout so `diff` works from inside the Lane without an explicit laneId.
  await transport.dispatch('open', { laneId: f.lane.laneId });
  await assert.rejects(
    transport.dispatch('diff', { format: 'unified', summary: true }),
    error => error.code === 'BAD_ARGUMENT',
  );
  const { result: withBinary } = await hostedAgentCli(
    f.root,
    'diff',
    { format: 'unified' },
    f.address,
    transport,
  );
  assert.equal(withBinary.format, 'unified');
  assert.equal(withBinary.base, f.lane.base.head);
  assert.equal(withBinary.head, f.lane.head);
  assert.equal(withBinary.nextCursor, null);
  assert.equal(withBinary.truncated, false);
  assert.match(withBinary.diff, /Binary files a\/assets\/logo\.bin and b\/assets\/logo\.bin differ/);
  assert.match(withBinary.diff, /Binary files a\/assets\/latin1\.txt and b\/assets\/latin1\.txt differ/);
  assert.doesNotMatch(withBinary.diff, /\\xe9/);
  assert.match(withBinary.diff, /Binary files differ/);
  assert.match(withBinary.diff, /--- a\/src\/edited\.ts\n\+\+\+ b\/src\/edited\.ts/);
  assert.match(withBinary.diff, /\\ No newline at end of file/);
  assertWholeHunks(withBinary.diff);

  // Text-only unified diff applies cleanly with `patch -p1` (and `git apply`) and matches head byte for byte.
  const textPaths = [...new Set([...Object.keys(baseText), ...Object.keys(headText)])].sort();
  const { result: textOnly } = await transport.dispatch('diff', {
    format: 'unified',
    paths: textPaths,
  });
  for (const tool of ['patch', 'git']) {
    const dir = mkdtempSync(join(tmpdir(), `forge-unified-${tool}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeTree(dir, baseText);
    if (tool === 'patch') execFileSync('patch', ['-p1', '-E', '-d', dir], { input: textOnly.diff });
    else execFileSync('git', ['apply'], { cwd: dir, input: textOnly.diff });
    const actual = readTree(dir);
    const expected = Object.fromEntries(
      Object.entries(headText).map(([path, text]) => [path, Buffer.from(text)]),
    );
    assert.deepEqual(actual, expected, `${tool} applied output equals head byte for byte`);
  }
});

test('Issue a37a53d3: unified diff paging ends on a whole file or hunk boundary, never splits a hunk, and concatenated pages apply with patch -p1', async t => {
  const block = (label, value) =>
    [
      `${label} context 1`,
      `${label} context 2`,
      `${label} context 3`,
      `${label} context 4`,
      `${label} ${value} ${'x'.repeat(160)}`,
      `${label} context 5`,
      `${label} context 6`,
      `${label} context 7`,
      `${label} context 8`,
    ].join('\n');
  const multiBase = ['a', 'b', 'c', 'd'].map(id => block(id, 'before')).join('\n') + '\n';
  const multiHead = ['a', 'b', 'c', 'd'].map(id => block(id, 'after')).join('\n') + '\n';
  const baseFiles = {
    '01-multi.txt': multiBase,
    '02-edit.txt': `start\n${'before-two-'.repeat(40)}\nend`,
    '03-delete.txt': 'remove line 1\nremove line 2\n',
  };
  const headFiles = {
    '01-multi.txt': multiHead,
    '02-edit.txt': `start\n${'after-two-'.repeat(40)}\nend`,
    '04-add.txt': 'brand new line 1\nbrand new line 2',
  };
  const f = agentFixture(t, { base: baseFiles, lane: headFiles });
  const transport = f.transport();
  await transport.dispatch('open', { laneId: f.lane.laneId });

  const pages = [];
  let command = { format: 'unified', byteBudget: 1024 };
  let sawMidFileHunkCursor = false;
  let sawWholeFileBoundaryCursor = false;
  while (command) {
    const { result } = await transport.dispatch('diff', command);
    assert.equal(result.format, 'unified');
    assert(result.cost.outputBytes <= 1024, `page respects byteBudget: ${result.cost.outputBytes}`);
    assertWholeHunks(result.diff);
    pages.push(result.diff);
    if (result.nextCursor) {
      assert.equal(result.truncated, true);
      assert.match(
        result.more,
        /^This page shows changed paths \d+-\d+ of 4; more pages follow\. Next page: /,
      );
      assert.equal(result.next.format, 'unified');
      assert.deepEqual(result.next.cursor, result.nextCursor);
      if (result.nextCursor.hunk !== undefined) sawMidFileHunkCursor = true;
      else sawWholeFileBoundaryCursor = true;
      const { action: _action, ...nextCommand } = result.next;
      command = nextCommand;
    } else {
      assert.equal(result.truncated, false);
      assert.equal(result.more, undefined);
      command = null;
    }
  }
  assert(pages.length >= 3, `expected at least 3 pages, got ${pages.length}`);
  assert.equal(sawMidFileHunkCursor, true, 'multi-hunk file splits cleanly at a hunk boundary');
  assert.equal(sawWholeFileBoundaryCursor, true, 'subsequent files split at a whole-file boundary');

  const dir = mkdtempSync(join(tmpdir(), 'forge-unified-paged-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(dir, baseFiles);
  execFileSync('patch', ['-p1', '-E', '-d', dir], { input: pages.join('') });
  const actual = readTree(dir);
  const expected = Object.fromEntries(
    Object.entries(headFiles).map(([path, text]) => [path, Buffer.from(text)]),
  );
  assert.deepEqual(actual, expected, 'concatenated unified pages apply byte for byte');

  // An oversized single hunk on a fresh page is reported in omitted with requiredByteBudget instead of exceeding byteBudget.
  const hugeHunk = agentFixture(t, {
    base: { 'row.txt': `${'a'.repeat(1400)}\n` },
    lane: { 'row.txt': `${'b'.repeat(1400)}\n` },
  });
  const { result: oversized } = await hugeHunk
    .transport()
    .dispatch('diff', { laneId: hugeHunk.lane.laneId, format: 'unified', byteBudget: 1024 });
  assert.equal(oversized.diff, '');
  assert.equal(oversized.cost.outputBytes, 0);
  assert.equal(oversized.truncated, true);
  assert.equal(oversized.omitted.length, 1);
  assert.equal(oversized.omitted[0].path, 'row.txt');
  assert.equal(oversized.omitted[0].reason, 'hunk-too-large');
  assert(oversized.omitted[0].requiredByteBudget > 1024);
  const { result: fitsOversized } = await hugeHunk.transport().dispatch('diff', {
    laneId: hugeHunk.lane.laneId,
    format: 'unified',
    byteBudget: oversized.omitted[0].requiredByteBudget,
  });
  assert.equal(fitsOversized.truncated, false);
  assertWholeHunks(fitsOversized.diff);
});
