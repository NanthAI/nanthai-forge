#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One fixed release-validation series. Retain the queue settings before agents run,
// then index each cell's original samples and result alongside the batch's void verdict.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchRootOrExit } from './bench-root.mjs';
import { gh, repository, rulesetName } from './github-arm.mjs';

const exec = promisify(execFile);
const releaseBatches = new Set(['n10-r1', 'overlap-n8-r1']);
const gitSha = /^[a-f0-9]{40}$/;
const stateHead = /^[a-f0-9]{64}$/;

export async function validationQueues(config, root) {
  const { cli, url, projectId } = config.forge;
  const readForge = exec(process.execPath, [
    cli,
    'agent',
    root,
    'policy',
    JSON.stringify({ url, projectId }),
    '--detail',
  ]);
  const readGitHub = async () => {
    const repoRules = `repos/${repository}/rulesets`;
    const rules = JSON.parse(await gh(['api', repoRules]));
    const active = rules.find(rule => rule.name === rulesetName && rule.enforcement === 'active');
    if (!active) throw Error('Release validation needs the active benchmark GitHub ruleset');
    return JSON.parse(await gh(['api', `${repoRules}/${active.id}`]));
  };
  const [forge, github] = await Promise.all([readForge, readGitHub()]);
  return queueSettings(
    JSON.parse(
      forge.stdout
        .split('\n')
        .filter(l => l.startsWith('{'))
        .at(-1),
    ).result,
    github,
  );
}

export function queueSettings(forge, github) {
  const mergeQueue = github.rules?.find(rule => rule.type === 'merge_queue');
  if (!forge?.acceptance || github.enforcement !== 'active' || !mergeQueue?.parameters)
    throw Error('Release validation queue settings could not be verified for both arms');
  return {
    forge: {
      preset: forge.preset,
      acceptance: forge.acceptance,
      stacking: forge.agentDefaults?.stacking ?? 'offer',
    },
    github: {
      repository,
      id: github.id,
      name: github.name,
      conditions: github.conditions,
      mergeQueue: mergeQueue.parameters,
      checks: github.rules.find(rule => rule.type === 'required_status_checks')?.parameters ?? null,
    },
  };
}

export function validationSelection(release, batch, dry) {
  if (!gitSha.test(release ?? '') || !releaseBatches.has(batch) || dry)
    throw Error(
      '--record-validation needs the final Git SHA and --only n10-r1 or --coordination --only overlap-n8-r1, for a scored batch',
    );
}

export function validationRegistration(release, batch, start, plan, config, queues) {
  if (
    start.harness.commit !== release ||
    start.githubMain !== release ||
    (start.cli.git ?? start.cli.commit) !== release ||
    !stateHead.test(start.cli.commit ?? '') ||
    !start.deploy?.databaseId
  )
    throw Error('Release validation expected the registered CLI, mirror, harness and deployment pins');
  return {
    schema: 1,
    kind: 'release-validation',
    series: `release-${release.slice(0, 12)}`,
    batch: batch.key,
    at: start.at,
    releaseGit: release,
    releaseState: start.cli.commit,
    source: {
      base: config.forge.mainBase,
      harnessDigest: start.harness.filesSha256,
      planDigest: plan.planSha256,
      planAmendmentsDigest: plan.planAmendmentsSha256 ?? null,
      tasksDigest: plan.design.tasksSha256,
      deployment: {
        runId: start.deploy.databaseId,
        head: start.deploy.headSha,
        convexTree: start.convexTree.deploy,
      },
      checkWorkflow: start.checkWorkflow,
    },
    queues,
    references: {
      method: 'docs/research/p6-exit-bench-plan.md',
      priorValidation: 'docs/research/p6-release-validation.md',
      publishedBaseline: 'docs/research/p6-exit-bench-results.md',
    },
    cells: batch.cells.map(cell => ({
      key: cell.key,
      slot: cell.slot ?? cell.arm,
      stacking: cell.stack ?? null,
    })),
  };
}

/** Reference the retained files by relative path. Missing evidence stays missing, including a stopped cell. */
export function validationEvidence(root, cells) {
  return {
    registration: 'validation.json',
    cells: cells.map(({ cellId, key, voided }) => {
      const stem =
        cellId && cellId === basename(cellId) && !['.', '..'].includes(cellId) ? `runs/${cellId}` : null;
      const retained = name => (stem && existsSync(join(root, stem, name)) ? `${stem}/${name}` : null);
      return { key, cellId, result: retained('result.json'), samples: retained('samples.jsonl'), voided };
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = benchRootOrExit();
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  const result = await validationQueues(config, root);
  console.log(JSON.stringify(result));
}
