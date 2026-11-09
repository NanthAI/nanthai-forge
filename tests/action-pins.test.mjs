// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { actionPinFindings, isWorkflowPath } from '../scripts/check-action-pins.mjs';
import { candidateStepFindings } from '../scripts/check-candidate-steps.mjs';
import { CACHE_PRESETS } from '../dist/actions-toolchains.js';
import { hostedWorkflowBlocks } from '../dist/actions-toolchains-hosted.js';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';
import { githubWorkflow } from '../scripts/bench-landing-workflow.mjs';

const sha = 'a'.repeat(40);
const step = uses => `jobs:\n  a:\n    steps:\n      - uses: ${uses}\n        with:\n          x: 1\n`;

test('action pin check refuses tags, branches and short SHAs and names the line', () => {
  for (const uses of [
    'actions/checkout@v4',
    'actions/checkout@main',
    'actions/checkout@11bd719',
    'actions/checkout',
    "'actions/setup-node@v4' # v4",
    'actions/cache/restore@v4',
    'docker://alpine:3',
  ])
    assert.deepEqual(
      actionPinFindings('.github/workflows/x.yml', step(uses)),
      ['.github/workflows/x.yml:4: pin the action to a full commit SHA (uses: owner/repo@SHA # vN)'],
      uses,
    );
  // A step-level `uses:` (no list dash) is checked too.
  assert.equal(
    actionPinFindings('w.yml', `      - name: up\n        uses: actions/upload-artifact@v4\n`).length,
    1,
  );
});

test('action pin check needs the pinned tag in a comment', () => {
  assert.deepEqual(actionPinFindings('w.yml', step(`actions/checkout@${sha}`)), [
    'w.yml:4: name the pinned tag in a comment (# vN)',
  ]);
  assert.equal(actionPinFindings('w.yml', step(`actions/checkout@${sha} # pinned`)).length, 1);
});

test('action pin check accepts SHA pins with a tag comment, local actions and image digests', () => {
  for (const uses of [
    `actions/checkout@${sha} # v4`,
    `actions/cache/restore@${sha} # v4.2.3`,
    `"actions/setup-node@${sha}" # 4.1.0`,
    './.github/actions/local',
    `docker://alpine@sha256:${'b'.repeat(64)}`,
  ])
    assert.deepEqual(actionPinFindings('w.yml', step(uses)), [], uses);
  assert.deepEqual(actionPinFindings('w.yml', 'run: echo uses: nothing\n'), []);
  assert.equal(isWorkflowPath('.github/workflows/ci.yml'), true);
  assert.equal(isWorkflowPath('.github/workflows/nested/ci.yaml'), false);
  assert.equal(isWorkflowPath('docs/ci.yml'), false);
});

test('committed, generated and benchmark workflows pin every action', () => {
  const workflows = readdirSync('.github/workflows')
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => [`.github/workflows/${name}`, readFileSync(`.github/workflows/${name}`, 'utf8')]);
  assert(workflows.length >= 6);
  // The release signer holds the release key: every action it runs must be pinned.
  const signer = workflows.find(([path]) => path === '.github/workflows/release-sign.yml');
  assert(signer, 'release-sign.yml is covered');
  assert.equal((signer[1].match(/uses: /g) ?? []).length, 2);
  for (const runsOn of ['ubuntu-latest', ['self-hosted', 'linux']])
    workflows.push([`generated ${runsOn}`, githubActionsWorkflow(runsOn)]);
  workflows.push(['benchmark', githubWorkflow({ ghShards: 2 })]);
  for (const [path, text] of workflows) {
    assert.match(text, /uses: /, path);
    assert.deepEqual(actionPinFindings(path, text), [], path);
  }
});

/** Jobs that can mint a GitHub OIDC token: `id-token: write` on the job, or on the whole workflow. */
function oidcJobs(path, text) {
  const [head, body = ''] = text.split(/^jobs:\s*$/m);
  const everyJob = /^\s*id-token:\s*write\b/m.test(head);
  return body
    .split(/^(?=  [\w-]+:\s*$)/m)
    .filter(block => /^  [\w-]+:/.test(block))
    .filter(block => everyJob || /^\s+id-token:\s*write\b/m.test(block))
    .map(block => ({ job: `${path} ${block.match(/^  ([\w-]+):/)[1]}`, block }));
}

test('every OIDC job pins every action it runs', () => {
  const jobs = readdirSync('.github/workflows')
    .filter(name => /\.ya?ml$/.test(name))
    .flatMap(name =>
      oidcJobs(`.github/workflows/${name}`, readFileSync(`.github/workflows/${name}`, 'utf8')),
    );
  // forge-check.yml hosted-plan/hosted-check/hosted-pack and foundation.yml native-selfhost today.
  assert(jobs.length >= 4, `found ${jobs.map(j => j.job).join(', ')}`);
  for (const { job, block } of jobs) {
    assert.match(block, /uses: /, job);
    assert.deepEqual(actionPinFindings(job, block), [], job);
  }
  // The job finder sees an unpinned action in an OIDC job, and workflow-wide permissions too.
  const unpinned = `permissions:\n  id-token: write\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n`;
  const [found] = oidcJobs('w.yml', unpinned);
  assert.equal(found.job, 'w.yml a');
  assert.equal(actionPinFindings(found.job, found.block).length, 1);
  assert.deepEqual(oidcJobs('w.yml', unpinned.replace('id-token', 'contents')), []);
});

// Candidate-step rules (scripts/check-candidate-steps.mjs, Issue 432164bf).
const SHA = '0057852bfaa89a56745cba8c7296529d2fc39830 # v4';
const main = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
const job = steps => `name: x\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
const restore = `      - id: forge-deps\n        uses: actions/cache/restore@${SHA}\n        env:\n          SEGMENT_DOWNLOAD_TIMEOUT_MINS: '1'\n        with:\n          path: ~/go\n          key: k\n`;
const save = when =>
  `      - if: ${when}\n        uses: actions/cache/save@${SHA}\n        with:\n          path: ~/go\n          key: k\n`;
const check = '      - run: node scripts/forge-check.mjs\n';

test('every workflow in this repository passes the Candidate-step rules', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  for (const name of readdirSync(dir).filter(file => /\.ya?ml$/.test(file)))
    assert.deepEqual(candidateStepFindings(name, readFileSync(new URL(name, dir), 'utf8')), [], name);
});

test('every generated workflow and hosted block passes: saves seed before the check, main only', () => {
  const declarations = [
    undefined,
    ...Object.keys(CACHE_PRESETS).map(preset => ({ cache: { presets: [preset] } })),
    { toolchains: [{ tool: 'go', versionFile: 'go.mod' }], cache: { presets: ['go', 'npm', 'cargo'] } },
  ];
  for (const declaration of declarations)
    for (const runner of ['ubuntu-latest', ['self-hosted', 'linux']])
      assert.deepEqual(
        candidateStepFindings('generated', githubActionsWorkflow(runner, declaration)),
        [],
        JSON.stringify(declaration),
      );
  for (const block of hostedWorkflowBlocks())
    assert.deepEqual(
      candidateStepFindings(
        'block',
        job(`${block}      - run: node control/scripts/hosted-actions-job.mjs run\n`),
      ),
      [],
    );
});

test('a clean check job passes; each broken rule is named', () => {
  assert.deepEqual(candidateStepFindings('ok', job(restore + save(main) + check)), []);
  const cases = [
    [restore + check + save(main), /save caches before the check step/],
    [restore + check + '      - run: echo done\n', /no step follows the check step/],
    [restore + '      - id: verdict\n        run: node scripts/forge-check.mjs\n', /has no id/],
    [
      restore + `${check}        env:\n          TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
      /no secret or workflow token/,
    ],
    [
      restore + `${check}        env:\n          GITHUB_TOKEN: \${{ github.token }}\n`,
      /no secret or workflow token/,
    ],
    [
      `      - uses: actions/cache@${SHA}\n        with:\n          path: ~/go\n          key: k\n${check}`,
      /explicit save/,
    ],
    [restore + save("steps.forge-deps.outputs.cache-hit != 'true'") + check, /only on the default branch/],
    [
      `      - uses: actions/cache/restore@${SHA}\n        with:\n          path: ~/go\n          key: k\n${check}`,
      /SEGMENT_DOWNLOAD_TIMEOUT_MINS/,
    ],
    [`      - run: npm ci --ignore-scripts\n${check}`, /npm ci a timeout/],
    [
      `      - run: node control/scripts/hosted-actions-job.mjs plan\n        env:\n          FORGE_ACTIONS_FOLD: '1'\n`,
      /FORGE_ACTIONS_FOLD/,
    ],
    [
      restore + '      - run: node control/scripts/hosted-actions-job.mjs run\n' + save(main),
      /never after it/,
    ],
  ];
  for (const [steps, finding] of cases) {
    const found = candidateStepFindings('bad.yml', job(steps));
    assert.ok(
      found.some(line => finding.test(line)),
      `${finding}: ${found.join('; ')}`,
    );
    assert.ok(
      found.every(line => /^bad\.yml(?::\d+)?: /.test(line)),
      'findings name locations only',
    );
  }
  // The server's main-audit flag also gates a hosted dependency seed.
  assert.deepEqual(
    candidateStepFindings(
      'hosted',
      job(restore + save("fromJSON(steps.plan.outputs.deps_cache || '{}').save") + check),
    ),
    [],
  );
});
