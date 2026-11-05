// SPDX-License-Identifier: Apache-2.0
// Contamination audit across agent clients (d8cf81b4): the same command must scan the same
// whether the agent sent it as raw shell text, Claude Bash JSON, a Codex function call, or
// Codex code-mode `exec` JavaScript (text(await tools.exec_command({cmd:"…"}))), which is the
// only format of the B1.5d real run. Fixtures are synthetic text in each real wire format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTask, commandText, shellCommands } from '../scripts/bench-t3code/contamination.mjs';

const BENCH = '/b/forge-bench/b15d';
const CELL = `${BENCH}/ws/github-n3-r1-a1-20261104T015045`;
const FORK = 'repos/NanthAI/forge-b15d-t3code';
const ctx = {
  prNumbers: [27097, 27514],
  ownPrs: [12],
  workspace: `${CELL}/t1`,
  ownRepo: 'NanthAI/forge-b15d-t3code',
  ownBranches: ['agent-1/t1'],
  toolPaths: [`${CELL}/bin`, `${CELL}/vp`, `${CELL}/hub`, `${BENCH}/deps`],
  benchRoot: BENCH,
};

// ---- the wire formats --------------------------------------------------------------------
const q = JSON.stringify;
const FORMATS = {
  plain: cmd => ({ tool: 'shell', input: cmd }),
  claude: cmd => ({ tool: 'Bash', input: q({ command: cmd, description: 'run' }) }),
  codexFunction: cmd => ({ tool: 'exec_command', input: q({ cmd, yield_time_ms: 1000 }) }),
  codexShellCall: cmd => ({ tool: 'shell', input: q({ command: ['bash', '-lc', cmd], workdir: '/w' }) }),
  codexExec: cmd => ({
    tool: 'exec',
    input: `text(await tools.exec_command({cmd:${q(cmd)},yield_time_ms:1000,max_output_tokens:4000}));`,
  }),
  codexExecAll: cmd => ({
    tool: 'exec',
    input: `const r = await Promise.allSettled([\ntools.exec_command({cmd:"pwd",workdir:"/w"}),\ntools.exec_command({cmd:${q(cmd)},max_output_tokens:2000}),\n]);\ntext(JSON.stringify(r));`,
  }),
  codexExecSingleQuoted: cmd =>
    cmd.includes("'")
      ? FORMATS.codexExec(cmd)
      : { tool: 'exec', input: `text(await tools.exec_command({cmd:'${cmd}',yield_time_ms:1000}));` },
  codexExecChars: cmd => ({
    tool: 'exec',
    input: `text(await tools.write_stdin({session_id:7,chars:${q(`${cmd}\n`)},yield_time_ms:1000}));`,
  }),
};
const hitsOf = (action, extra = {}) =>
  scanTask({ session: { source: 'transcript', actions: [action], seen: [] }, ...ctx, ...extra }).hits.map(
    h => h.id,
  );
const everyFormat = (cmd, check) => {
  for (const [name, make] of Object.entries(FORMATS)) check(hitsOf(make(cmd)), `${name}: ${cmd}`);
};
const clean = cmd => everyFormat(cmd, (hits, label) => assert.deepEqual(hits, [], label));
const voids = (cmd, id) =>
  everyFormat(cmd, (hits, label) => assert.ok(hits.includes(id), `${label} should hit ${id}, got ${hits}`));

// ---- true contamination voids in every format --------------------------------------------
test('PR lists, compare, events, refs lists and other repos void in every format', () => {
  for (const bad of [
    `gh api ${FORK}/pulls`,
    `gh api "${FORK}/pulls?state=all" --jq '.[].number'`,
    `gh api ${FORK}/pulls --paginate | head -50`,
    `gh api repos/someone/else/pulls`,
    `gh api ${FORK}/compare/main...agent-2/t2`,
    `gh api ${FORK}/events`,
    `gh api ${FORK}/issues/7/events`,
    `gh api ${FORK}/git/refs`,
    `gh api ${FORK}/git/matching-refs/heads/agent`,
    'gh api repos/someone/else/branches',
    `cd /w/t1 && gh api ${FORK}/pulls`,
    `GH_PAGER=cat gh api ${FORK}/pulls`,
    `gh api -X GET ${FORK}/pulls -f state=all`,
    `gh api --method POST repos/someone/else/pulls -f title=x`,
  ])
    voids(bad, 'github-history-api');
});

test('git ls-remote of anything but the own branch and main voids in every format', () => {
  for (const bad of [
    'git ls-remote origin',
    'git ls-remote origin | head',
    'git ls-remote --heads origin',
    'git ls-remote origin agent-2/t9',
    'git ls-remote --heads origin main agent-2/t9',
    'cd /w/t1 && git ls-remote origin 2>&1 | head -20',
    'git ls-remote https://github.com/NanthAI/forge-b15d-oracle',
  ])
    voids(bad, 'git-history-all');
  voids('git log --all --oneline', 'git-history-all');
});

test('reads and fetches of upstream void in every format, including inside scripts', () => {
  for (const bad of [
    'gh api repos/pingdotgg/t3code/pulls/27097',
    'gh api repos/pingdotgg/t3code/pulls/27097/files --jq .[].filename',
    'curl -s https://api.github.com/repos/pingdotgg/t3code/pulls/9 | head',
    'git fetch https://github.com/pingdotgg/t3code main',
    'git remote add upstream https://github.com/pingdotgg/t3code.git',
    'gh pr view https://github.com/pingdotgg/t3code/pull/27097 --json files',
    'gh issue view pingdotgg/t3code#123',
    'gh pr diff 27097 -R pingdotgg/t3code',
    'gh pr create --repo pingdotgg/t3code --title x',
    `node -e "fetch('https://api.github.com/repos/pingdotgg/t3code/pulls').then(r => r.text())"`,
    `bash -lc 'gh pr diff 27097 -R pingdotgg/t3code'`,
    `bash -c "cd repo && curl -s https://api.github.com/repos/pingdotgg/t3code/commits"`,
    'cd /w/t1 && git fetch https://github.com/pingdotgg/t3code main && git log FETCH_HEAD',
    // A heredoc body fed to an interpreter is part of its command.
    `python3 - <<'PY'\nimport urllib.request\nprint(urllib.request.urlopen('https://api.github.com/repos/pingdotgg/t3code/pulls').read())\nPY`,
    `python3 - <<EOF\nimport subprocess\nsubprocess.run(['gh', 'api', 'repos/pingdotgg/t3code/pulls'])\nEOF`,
    `node <<'JS'\nconst r = await fetch('https://github.com/pingdotgg/t3code/pull/9.diff');\nconsole.log(await r.text());\nJS`,
    `bash <<'SH'\ngh pr diff 27097 -R pingdotgg/t3code\nSH`,
    `cat > /tmp/s.sh <<'SH'\necho hi\nSH\nruby -rnet/http -e "puts Net::HTTP.get(URI('https://github.com/pingdotgg/t3code/pulls'))"`,
    `python3 fetch.py https://github.com/pingdotgg/t3code/pulls`,
  ])
    voids(bad, 'upstream');
});

// ---- the false positives of the real run stay clean in every format ----------------------
test('own-fork reads and writes are clean in every format', () => {
  for (const ok of [
    `gh api ${FORK}/rules/branches/main`,
    `gh api ${FORK}/branches/main/protection | head`,
    `gh api ${FORK}/pulls/12 --jq .mergeable_state`,
    `gh api ${FORK}/issues/12/events`,
    `gh api --paginate ${FORK}/branches`,
    `gh api /${FORK}/git/ref/heads/agent-1/t1`,
    // Writes to the own fork: creating its own PR or branch is no read of history.
    `gh api --method POST ${FORK}/pulls -f title='Fix' -f head=agent-1/t1 -f base=main`,
    `gh api -X POST ${FORK}/git/refs -f ref=refs/heads/agent-1/t1 -f sha=abcdef0`,
    `gh api --method=POST ${FORK}/pulls -f title=x -f head=agent-1/t1 -f base=main`,
    `gh api -XPOST ${FORK}/pulls -f title=x -f head=agent-1/t1 -f base=main`,
    `gh api ${FORK}/pulls -f title=x -f head=agent-1/t1 -f base=main`, // fields make it a POST
    `gh api ${FORK}/pulls --raw-field title=x -F draft=true`,
    `gh api --method PATCH ${FORK}/pulls/12 -f state=closed`,
    `gh api -X PUT ${FORK}/pulls/12/merge -f merge_method=squash`,
    `gh api --method DELETE ${FORK}/git/refs/heads/agent-1/t1`,
    `gh api --method POST repos/{owner}/{repo}/pulls -f title=x -f head=agent-1/t1`,
    `gh api --method POST ${FORK}/pulls --input /tmp/pr.json --jq .html_url`,
  ])
    clean(ok);
});

test('ls-remote of the own branch and main is clean in every format', () => {
  for (const ok of [
    'git ls-remote --heads origin main agent-1/t1',
    'git ls-remote origin refs/heads/agent-1/t1 refs/heads/main',
    'git ls-remote origin refs/heads/agent-1/t1 refs/heads/main 2>&1 | head',
    'cd /w/t1 && git ls-remote --exit-code origin main',
    `bash -lc "git ls-remote --heads origin main agent-1/t1"`,
    'git ls-remote origin gh-readonly-queue/main/pr-12-abcdef',
  ])
    clean(ok);
});

test('issue links in text the agent writes are clean in every format', () => {
  const body =
    'Fix the thing.\n\nCloses https://github.com/pingdotgg/t3code/issues/123\nRefs pingdotgg/t3code#123';
  for (const ok of [
    `gh pr create --title Fix --body "Closes https://github.com/pingdotgg/t3code/issues/123"`,
    `gh pr create --title Fix --body "$(cat <<'EOF'\n${body}\nEOF\n)"`,
    `git commit -m "Refs pingdotgg/t3code#123"`,
    `git add -A && git commit -m "Fix\n\nCloses https://github.com/pingdotgg/t3code/issues/123"`,
    `gh pr edit 12 --body "Closes https://github.com/pingdotgg/t3code/issues/123"`,
    `gh pr comment 12 --body "don't repeat; see pingdotgg/t3code#123"`,
    `gh pr create --title Fix --body-file - <<'EOF'\n${body}\nEOF`,
    // Fields of an API write to the own fork are text the agent writes.
    `gh api --method POST ${FORK}/pulls -f title=Fix -f head=agent-1/t1 -f base=main -f body='Closes https://github.com/pingdotgg/t3code/issues/123'`,
    // A script that only writes the PR body to a file mentions upstream; it fetches nothing.
    `python3 - <<'PY'\nfrom pathlib import Path\nPath('/tmp/pr.md').write_text('''${body}\n''')\nPY\ngh pr create --repo NanthAI/forge-b15d-t3code --body-file /tmp/pr.md`,
    `cat > /tmp/pr.md <<'EOF'\n${body}\nEOF`,
  ])
    clean(ok);
});

// ---- command extraction --------------------------------------------------------------------
test('commandText reads the command out of each wire format', () => {
  const cmd = `cd /w && gh api ${FORK}/pulls --jq '.[].number'`;
  for (const make of Object.values(FORMATS)) {
    const { tool, input } = make(cmd);
    assert.ok(
      commandText(input, tool).includes(cmd.replace(/^cd \/w && /, '')) ||
        commandText(input, tool).includes(cmd),
      input,
    );
  }
  // Escapes, single quotes, template literals, concatenation and argv arrays of a Codex script.
  const js = [
    'text(await tools.exec_command({cmd:"echo \\"a b\\"\\ngit ls-remote origin",yield_time_ms:1000}));',
    "text(await tools.exec_command({cmd:'gh api x',workdir:'/w'}));",
    'text(await tools.exec_command({cmd:`gh api ${repo}/pulls`}));',
    'text(await tools.exec_command({cmd:"git ls-remote " + "origin"}));',
    'text(await tools.exec_command({command:["bash","-lc","gh pr list"]}));',
  ];
  const out = js.map(s => commandText(s, 'exec'));
  assert.equal(out[0], 'echo "a b"\ngit ls-remote origin');
  assert.equal(out[1], 'gh api x');
  assert.equal(out[2], 'gh api ${repo}/pulls');
  assert.equal(out[3], 'git ls-remote origin');
  assert.equal(out[4], 'gh pr list');
  // The workdir and patches are not commands.
  assert.equal(commandText('text(await tools.exec_command({cmd:"ls",workdir:"/w/t1"}));', 'exec'), 'ls');
  assert.equal(
    commandText('text(await tools.apply_patch("*** Begin Patch\\n+git fetch pingdotgg\\n"));', 'exec'),
    '',
  );
  assert.equal(commandText(q({ file_path: 'a.md', content: 'gh api x/pulls' }), 'Write'), '');
  // A command held in a variable still yields the script's string literals.
  assert.match(
    commandText(
      'const c = "gh api repos/pingdotgg/t3code/pulls";\ntext(await tools.exec_command({cmd:c}));',
      'exec',
    ),
    /gh api repos\/pingdotgg\/t3code\/pulls/,
  );
});

test('shellCommands resolves quotes, wrappers, redirections, substitutions and heredocs', () => {
  // Substitutions are listed before the command that holds them: compare as sets.
  const same = (s, expected) =>
    assert.deepEqual(
      shellCommands(s)
        .map(c => c.text)
        .sort(),
      [...expected].sort(),
    );
  same('FOO=1 sudo env -i X=2 git ls-remote origin main 2>&1 | tee out', [
    'git ls-remote origin main',
    'tee out',
  ]);
  same(`bash -lc 'cd x; git ls-remote "origin" main' > /dev/null`, ['cd x', 'git ls-remote origin main']);
  same('echo "$(git ls-remote origin)" && ls', [
    'echo $(git ls-remote origin)',
    'git ls-remote origin',
    'ls',
  ]);
  same('echo `gh api x/pulls` # not a command: git fetch', ['echo `gh api x/pulls`', 'gh api x/pulls']);
  same('for f in a b; do git fetch $f; done', ['for f in a b', 'git fetch $f']);
  same("python3 - <<'PY' | head\nprint('hi')\nPY\nls", ["python3 -\nprint('hi')", 'head', 'ls']);
  same('python3 - <<-EOF\n\tx = 1\n\tEOF\nls', ['python3 -\n\tx = 1', 'ls']);
  same('git commit -m "a \\"quoted\\" word" && ls', ['git commit -m a "quoted" word', 'ls']);
  same('gh issue view #12 --repo x/y', ['gh issue view #12 --repo x/y']);
  // A heredoc body with an apostrophe inside $( ) does not swallow the rest of the line.
  same(`git commit -m "$(cat <<'EOF'\ndon't\nEOF\n)" && git push`, [
    `cat\ndon't`,
    `git commit -m $(cat <<'EOF'\ndon't\nEOF\n)`,
    'git push',
  ]);
});
