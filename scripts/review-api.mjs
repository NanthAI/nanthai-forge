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
//   node scripts/review-api.mjs --spend     today's and this month's spend per provider against the credit
//   Calibration on a landed Lane: add --lane-id LANE_ID --files-root DIR (files are read from DIR, e.g. main).
//
// Keys come from the macOS keychain (docs/agents/review-api.md); no key value is printed, logged or
// sent anywhere but its provider. Forge cost: reads only (`diff`, `planning`), one page each.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { SPILL_CODES, callProvider, failureReason } from './review-api-call.mjs';
import {
  DEFAULTS,
  ReviewError,
  changedPaths,
  checkCaps,
  dailyCapUsd,
  estimateUsd,
  formatReport,
  formatSpend,
  mergeConfig,
  planRoute,
  priceFor,
  spendReport,
  spentOn,
  systemPrompt,
  tierFromText,
  userPrompt,
} from './review-api-lib.mjs';

const run = promisify(execFile);
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
]);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) throw new ReviewError('REVIEW_ARGS', `Unexpected argument ${argv[i]}.`);
    if (VALUE_FLAGS.has(name)) args[name] = argv[++i];
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

/** The real nforge/keychain/network edges; tests pass fakes for each. */
export const realDeps = {
  async nforge(lane, action, json) {
    const { stdout } = await run('nforge', ['agent', lane, action, JSON.stringify(json)], {
      maxBuffer: 32 << 20,
    });
    const line = stdout
      .split('\n')
      .reverse()
      .find(l => l.startsWith('{'));
    if (!line) throw new ReviewError('REVIEW_NFORGE', `nforge ${action} printed no JSON.`);
    const parsed = JSON.parse(line);
    if (parsed.error)
      throw new ReviewError('REVIEW_NFORGE', `nforge ${action}: ${parsed.error.code ?? 'error'}.`);
    return parsed;
  },
  readKey(service) {
    try {
      return execFileSync('security', ['find-generic-password', '-s', service, '-a', 'forge', '-w'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      return '';
    }
  },
  // Plain Node with no dist/ helper (builders run this from a Lane): one POST per attempt, deadline set
  // by the caller. A retry is only for 429/5xx or unusable GPT text, under the caps. Exempt as
  // 'standalone' in check-network-boundaries.
  request: (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(DEFAULTS.timeoutMs) }),
  /** Pause before the one retry of a 429/5xx. */
  backoff: ms => new Promise(resolve => setTimeout(resolve, ms)),
  /** A regular file that really lives under `root` (no symlink, no `..`), as UTF-8 text; else null. */
  readText(root, rel) {
    try {
      const path = join(root, rel);
      const inside = realpathSync(path).startsWith(`${realpathSync(root)}${sep}`);
      if (!inside || !lstatSync(path).isFile()) return null;
      const text = readFileSync(path, 'utf8');
      return text.includes('\0') ? null : text;
    } catch {
      return null;
    }
  },
  /** Local routing/credit overrides (see CONFIG in review-api-lib.mjs); {} when the file is absent. */
  localConfig(file = process.env.FORGE_REVIEW_CONFIG ?? join(homedir(), '.forge-review', 'config.json')) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new ReviewError('REVIEW_CONFIG', `Cannot read review config ${file}: ${error?.name ?? 'error'}.`);
    }
  },
  spendLog: process.env.FORGE_REVIEW_SPEND_LOG ?? join(homedir(), '.forge-review', 'spend.jsonl'),
  now: () => new Date(),
  out: text => process.stdout.write(`${text}\n`),
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
    const read = await deps.nforge(args.lane, 'planning', { planningItemId: args.item });
    const it = read.result?.item;
    const list = read.result?.comments ?? [];
    const comments = list
      .map(c => `- ${c.body ?? c.text ?? ''}`)
      .join('\n')
      .slice(0, 8_000);
    if (list.length >= 50) notes.push('The Item has 50 or more comments; older ones may be missing.');
    item = `${it?.title ?? ''}\n${(it?.body ?? '').slice(0, 16_000)}${comments ? `\n\nComments (can amend Done-when):\n${comments}` : ''}`;
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
  const promptBytes = Buffer.byteLength(system) + Buffer.byteLength(user);
  const tier = args.tier ?? tierFromText(input.item) ?? 'standard';
  const routes = planRoute({
    builderModel: args['builder-model'],
    tier,
    provider: args.provider,
    model: args.model,
    config,
  });

  // Routes are tried in order. A provider with no room under its caps, no key, or one that keeps failing
  // (429/5xx after one retry, a timeout or network error, an unusable reply) hands over to the next; a
  // per-call cap breach is about this prompt, not the provider, and stops the review. When every route
  // fails the builder falls back to a subscription reviewer. A pinned provider never spills.
  const day = deps.now().toISOString().slice(0, 10);
  const maxCallUsd = number(args['max-call-usd'], DEFAULTS.maxCallUsd, 'max-call-usd');
  const routeNotes = [];
  const failures = [];
  const capsFor = (provider, estimate) => {
    const log = readLog();
    checkCaps({
      estimate,
      spentTodayUsd: spentOn(day, log, provider),
      maxCallUsd,
      maxDayUsd: dailyCapUsd(config, provider, dayCapFlag),
      spentMonthUsd: spentOn(day.slice(0, 7), log, provider),
      monthlyCreditUsd: config.providers[provider].monthlyCreditUsd,
    });
  };
  let lastError;
  let onlyCaps = true;
  for (const route of routes) {
    const { provider, model } = route;
    const price = priceFor(provider, model, {
      input: number(args['price-in'], undefined, 'price-in'),
      output: number(args['price-out'], undefined, 'price-out'),
    });
    const estimate = estimateUsd(price, promptBytes, maxOutputTokens);
    try {
      capsFor(provider, estimate);
    } catch (error) {
      if (error.code !== 'REVIEW_DAY_CAP' && error.code !== 'REVIEW_MONTH_CAP') throw error;
      routeNotes.push(`${provider} is at its ${error.code === 'REVIEW_DAY_CAP' ? 'daily' : 'monthly'} cap`);
      failures.push(`${provider}: ${error.message}`);
      lastError = error;
      continue;
    }
    const routeNote = routeNotes.length
      ? `Routed to ${provider}/${model} because ${routeNotes.join('; ')}.`
      : undefined;
    if (args['dry-run'])
      return deps.out(
        `Dry run: ${promptBytes} prompt bytes, worst case $${estimate.toFixed(3)} on ${provider}/${model} (tier ${tier}); nothing sent.${routeNote ? ` ${routeNote}` : ''}`,
      );
    try {
      const done = await callProvider({
        deps,
        args,
        input,
        route,
        tier,
        price,
        estimate,
        system,
        user,
        maxOutputTokens,
        roomToRetry: () => capsFor(provider, estimate),
      });
      const meta = {
        provider,
        model,
        tier,
        usage: done.usage,
        usd: done.usd,
        spentTodayUsd: spentOn(day, readLog(), provider), // settled log: failed attempts count as the cap sees them
        route: routeNote,
      };
      return deps.out(
        args.json ? JSON.stringify({ ...done.parsed, ...meta }) : formatReport(done.parsed, meta),
      );
    } catch (error) {
      if (!SPILL_CODES.has(error.code)) throw error;
      onlyCaps = false;
      routeNotes.push(`${provider} failed (${failureReason(error)})`);
      failures.push(`${provider}: ${error.message}`);
      lastError = error;
    }
  }
  if (routes.length === 1) throw lastError; // pinned: the original error, no spill
  throw new ReviewError(
    onlyCaps ? lastError.code : 'REVIEW_NO_REVIEWER',
    `${failures.join(' ')} No API reviewer has room or answered on either provider; use a subscription reviewer.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  review(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.code ?? 'REVIEW_ERROR'}: ${error.message}\n`);
    process.exitCode = error instanceof ReviewError ? 2 : 1;
  });
