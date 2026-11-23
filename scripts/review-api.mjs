// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Review round by API call (Item f082efd6). A builder runs this from a saved Lane instead of spending a
// subscription reviewer: one request to the Anthropic Messages API or the OpenAI Responses API, findings
// ranked by severity, tokens and dollars printed and appended to a local spend log.
//
//   node scripts/review-api.mjs --lane LANE_PATH --item ITEM_ID [--builder-model M] [--tier core|standard]
//     [--provider anthropic|openai] [--model M] [--effort low|medium|high] [--context-bytes N]
//     [--max-call-usd N] [--max-day-usd N] [--price-in N --price-out N] [--spend-log FILE] [--config FILE]
//     [--dry-run] [--json]
//     [--mock MOCK.png ... --shot SHOT.png ...]   UI Lane with a design mock: add the mock check (review-mock.mjs)
//   node scripts/review-api.mjs --spend     today's and this month's spend per provider against the credit
//   Calibration on a landed Lane: add --lane-id LANE_ID --files-root DIR (files are read from DIR, e.g. main).
//
// Keys come from the macOS keychain (docs/agents/review-api.md); no key value is printed, logged or
// sent anywhere but its provider. Forge cost: reads only (`diff`, `planning`), one page each; the mock check
// reuses the Item read.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realDeps } from './review-api-deps.mjs';
import { readItem } from './review-api-item.mjs';
import { reviewMockWith } from './review-mock.mjs';
import { runDouble, runRoutes } from './review-api-route.mjs';
import {
  DEFAULTS,
  ReviewError,
  changedPaths,
  formatSpend,
  mergeConfig,
  planRoute,
  spendReport,
  systemPrompt,
  tierFromText,
  userPrompt,
} from './review-api-lib.mjs';

export { realDeps };
const VALUE_FLAGS = new Set([
  'lane',
  'item',
  'provider',
  'model',
  'effort',
  'context-bytes',
  'max-call-usd',
  'max-day-usd',
  'max-output-tokens',
  'price-in',
  'price-out',
  'spend-log',
  'diff-pages',
  'lane-id',
  'files-root',
  'builder-model',
  'tier',
  'config',
  'image-bytes',
]);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) throw new ReviewError('REVIEW_ARGS', `Unexpected argument ${argv[i]}.`);
    if (name === 'mock' || name === 'shot') (args[name] ??= []).push(argv[++i]);
    else if (VALUE_FLAGS.has(name)) args[name] = argv[++i];
    else if (['dry-run', 'json', 'spend'].includes(name)) args[name] = true;
    else throw new ReviewError('REVIEW_ARGS', `Unknown flag --${name}.`);
  }
  return args;
}

const number = (value, fallback, flag) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!(parsed >= 0)) throw new ReviewError('REVIEW_ARGS', `--${flag} must be a number.`);
  return parsed;
};

async function gatherInput(args, deps, contextBytes) {
  const pages = [];
  let cursor;
  let laneId = null;
  const notes = [];
  for (let page = 0; page < Number(args['diff-pages'] ?? 5); page++) {
    const reply = await deps.nforge(args.lane, 'diff', {
      format: 'unified',
      byteBudget: 200_000,
      ...(args['lane-id'] ? { laneId: args['lane-id'] } : {}),
      ...(cursor ? { cursor } : {}),
    });
    laneId = reply.sourceContext?.laneId ?? laneId;
    pages.push(reply.result?.diff ?? '');
    for (const omitted of reply.result?.omitted ?? [])
      notes.push(`Diff omitted for ${omitted.path ?? omitted}.`);
    cursor = reply.result?.nextCursor;
    if (!cursor) break;
  }
  if (cursor) notes.push('The diff has more pages than were read; the review covers the first pages only.');
  const diff = pages.join('');
  let item = '';
  if (args.item) {
    const read = await readItem(deps, args.lane, args.item);
    item = read.text;
    notes.push(...read.notes);
  }
  const files = changedPaths(diff).map(path => ({
    path,
    text: deps.readText(args['files-root'] ?? args.lane, path),
  }));
  const agents = deps.readText(args.lane, 'AGENTS.md') ?? '';
  const safety =
    agents
      .split('\n')
      .find(l => l.startsWith('- Never print environment values or secrets'))
      ?.slice(2) ?? '';
  return { laneId, diff, item, files, notes, safety, contextBytes };
}

export async function review(argv, defaults = realDeps) {
  const args = parseArgs(argv);
  const deps = args['spend-log'] ? { ...defaults, spendLog: args['spend-log'] } : defaults;
  const config = mergeConfig(deps.localConfig(args.config));
  const readLog = () => (existsSync(deps.spendLog) ? readFileSync(deps.spendLog, 'utf8') : '');
  const dayCapFlag =
    args['max-day-usd'] === undefined ? undefined : number(args['max-day-usd'], 0, 'max-day-usd');
  if (args.spend) {
    const report = spendReport(readLog(), deps.now(), config, dayCapFlag);
    return deps.out(args.json ? JSON.stringify(report) : formatSpend(report));
  }
  if (!args.lane)
    throw new ReviewError(
      'REVIEW_ARGS',
      'Pass --lane LANE_PATH (a saved Lane; the diff is base to saved head).',
    );
  const maxOutputTokens = number(args['max-output-tokens'], DEFAULTS.maxOutputTokens, 'max-output-tokens');
  const input = await gatherInput(
    args,
    deps,
    number(args['context-bytes'], DEFAULTS.contextBytes, 'context-bytes'),
  );
  if (!input.diff.trim())
    throw new ReviewError(
      'REVIEW_EMPTY',
      'The saved diff is empty. Save your work first (the review reads base to saved head).',
    );
  const system = systemPrompt(input.safety);
  const user = userPrompt({ ...input });
  const tier = args.tier ?? tierFromText(input.item) ?? 'standard';
  const routes = planRoute({
    builderModel: args['builder-model'],
    tier,
    provider: args.provider,
    model: args.model,
    config,
  });
  const ctx = {
    args,
    deps,
    config,
    input,
    system,
    user,
    tier,
    routes,
    promptBytes: Buffer.byteLength(system) + Buffer.byteLength(user),
    maxOutputTokens,
    maxCallUsd: number(args['max-call-usd'], DEFAULTS.maxCallUsd, 'max-call-usd'),
    dayCapFlag,
    priceOverride: {
      input: number(args['price-in'], undefined, 'price-in'),
      output: number(args['price-out'], undefined, 'price-out'),
    },
    day: deps.now().toISOString().slice(0, 10),
    readLog,
  };
  // A core Lane (queue, landing, ledger, auth, deletion) asks both providers at once; any other review, or a
  // pinned provider, goes to one reviewer with the other as the fallback (review-api-route.mjs).
  await (tier === 'core' && routes.every(route => !route.pinned) ? runDouble(ctx) : runRoutes(ctx));
  // A UI Lane with a design mock: the mock check follows in the same round, from the Item text read above.
  if (args.mock || args.shot)
    await reviewMockWith({ ...args, model: undefined, provider: undefined }, deps, {
      text: input.item,
      notes: [],
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  review(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.code ?? 'REVIEW_ERROR'}: ${error.message}\n`);
    process.exitCode = error instanceof ReviewError ? 2 : 1;
  });
