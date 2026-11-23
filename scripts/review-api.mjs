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
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULTS,
  KEYCHAIN,
  ReviewError,
  buildRequest,
  changedPaths,
  checkCaps,
  costUsd,
  dailyCapUsd,
  estimateUsd,
  formatReport,
  formatSpend,
  mergeConfig,
  parseFindings,
  planRoute,
  priceFor,
  readReply,
  redact,
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
  // Plain Node with no dist/ helper (builders run this from a Lane): one POST, no retry (a retried POST
  // would bill twice), deadline set by the caller. Exempt as 'standalone' in check-network-boundaries.
  request: (url, init) => globalThis.fetch(url, init),
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

  // The first route whose provider still has room today and this month takes the review; a provider at
  // its daily cap hands over to the next. A per-call cap breach is about this prompt, not the provider.
  const day = deps.now().toISOString().slice(0, 10);
  const maxCallUsd = number(args['max-call-usd'], DEFAULTS.maxCallUsd, 'max-call-usd');
  const routeNotes = [];
  const capErrors = [];
  let route;
  let price;
  let estimate;
  let spentBefore;
  const capFor = provider => dailyCapUsd(config, provider, dayCapFlag);
  for (const candidate of routes) {
    const candidatePrice = priceFor(candidate.provider, candidate.model, {
      input: number(args['price-in'], undefined, 'price-in'),
      output: number(args['price-out'], undefined, 'price-out'),
    });
    const candidateEstimate = estimateUsd(candidatePrice, promptBytes, maxOutputTokens);
    const log = readLog();
    const today = spentOn(day, log, candidate.provider);
    try {
      checkCaps({
        estimate: candidateEstimate,
        spentTodayUsd: today,
        maxCallUsd,
        maxDayUsd: capFor(candidate.provider),
        spentMonthUsd: spentOn(day.slice(0, 7), log, candidate.provider),
        monthlyCreditUsd: config.providers[candidate.provider].monthlyCreditUsd,
      });
    } catch (error) {
      if (error.code !== 'REVIEW_DAY_CAP' && error.code !== 'REVIEW_MONTH_CAP') throw error;
      routeNotes.push(
        `${candidate.provider} is at its ${error.code === 'REVIEW_DAY_CAP' ? 'daily' : 'monthly'} cap`,
      );
      capErrors.push(`${candidate.provider}: ${error.message}`);
      continue;
    }
    route = candidate;
    price = candidatePrice;
    estimate = candidateEstimate;
    spentBefore = today;
    break;
  }
  if (!route)
    throw new ReviewError(
      'REVIEW_DAY_CAP',
      `${capErrors.join(' ')} No API reviewer has room${routes.length > 1 ? ' on either provider' : ''}; use a subscription reviewer.`,
    );
  const { provider, model } = route;
  const routeNote = routeNotes.length
    ? `Routed to ${provider}/${model} because ${routeNotes.join('; ')}.`
    : undefined;
  const request = buildRequest(provider, {
    model,
    system,
    user,
    maxOutputTokens,
    effort: args.effort ?? 'high',
  });
  if (args['dry-run'])
    return deps.out(
      `Dry run: ${promptBytes} prompt bytes, worst case $${estimate.toFixed(3)} on ${provider}/${model} (tier ${tier}); nothing sent.${routeNote ? ` ${routeNote}` : ''}`,
    );

  const key = deps.readKey(KEYCHAIN[provider]);
  if (!key)
    throw new ReviewError(
      'REVIEW_NO_KEY',
      `No ${provider} key in the keychain (service ${KEYCHAIN[provider]}, account forge). Ask the lead to add it; nothing was sent.`,
    );
  const headers = { ...request.headers, [request.keyHeader]: `${request.keyPrefix ?? ''}${key}` };
  // Reserve the worst case first so concurrent builders see it; the call row settles it. A failure
  // whose billing is unknown (timeout, network, 5xx, unreadable body) settles at the reservation.
  // One attempt: reserve the worst case first so concurrent builders see it; the call row settles it. A
  // failure whose billing is unknown (timeout, network, 5xx, unreadable body) settles at the reservation.
  const attempt = async () => {
    const id = randomUUID();
    const append = row => {
      mkdirSync(dirname(deps.spendLog), { recursive: true });
      appendFileSync(
        deps.spendLog,
        `${JSON.stringify({
          id,
          time: deps.now().toISOString(),
          lane: input.laneId,
          item: args.item ?? null,
          provider,
          model,
          tier,
          ...row,
        })}\n`,
      );
    };
    append({ kind: 'reserve', usd: Number(estimate.toFixed(6)) });
    const unknownBilling = () => append({ kind: 'call', usd: Number(estimate.toFixed(6)), estimated: true });
    let raw;
    let response;
    try {
      response = await deps.request(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(DEFAULTS.timeoutMs),
      });
      raw = await response.text();
    } catch (error) {
      unknownBilling();
      throw new ReviewError('REVIEW_NETWORK', redact(`Request failed: ${error?.name ?? 'error'}.`, [key]));
    }
    if (!response.ok) {
      if (response.status >= 500) unknownBilling();
      else append({ kind: 'call', usd: 0 }); // a 4xx was rejected before any generation
      throw new ReviewError(
        'REVIEW_HTTP',
        `${provider} returned ${response.status}: ${redact(raw, [key]).slice(0, 400)}`,
      );
    }
    const settle = usage => {
      const usd = costUsd(price, usage);
      append({
        kind: 'call',
        inputTokens: usage.input,
        cachedTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output,
        usd: Number(usd.toFixed(6)),
      });
      return usd;
    };
    let reply;
    try {
      reply = readReply(provider, JSON.parse(raw));
    } catch (error) {
      if (error.usage) settle(error.usage); // a refused or truncated call is still billed
      else unknownBilling();
      throw error;
    }
    return { text: reply.text, usage: reply.usage, usd: settle(reply.usage) };
  };

  let result = await attempt();
  let totalUsd = result.usd;
  let parsed;
  try {
    parsed = parseFindings(result.text);
  } catch (error) {
    // GPT now and then returns text that is not the JSON object despite the strict schema. The call is
    // billed and logged; retry once with the same request, so its worst case equals the first
    // reservation, and only if both caps still have room for it.
    if (error.code !== 'REVIEW_UNPARSEABLE' || provider !== 'openai') throw error;
    const log = readLog();
    try {
      checkCaps({
        estimate,
        spentTodayUsd: spentOn(day, log, provider),
        maxCallUsd,
        maxDayUsd: capFor(provider),
        spentMonthUsd: spentOn(day.slice(0, 7), log, provider),
        monthlyCreditUsd: config.providers[provider].monthlyCreditUsd,
      });
    } catch {
      throw new ReviewError('REVIEW_UNPARSEABLE', `${error.message} No room under the caps to retry.`);
    }
    result = await attempt();
    totalUsd += result.usd;
    parsed = parseFindings(result.text);
  }
  const meta = {
    provider,
    model,
    tier,
    usage: result.usage,
    usd: totalUsd,
    spentTodayUsd: spentBefore + totalUsd,
    route: routeNote,
  };
  deps.out(args.json ? JSON.stringify({ ...parsed, ...meta }) : formatReport(parsed, meta));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  review(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.code ?? 'REVIEW_ERROR'}: ${error.message}\n`);
    process.exitCode = error instanceof ReviewError ? 2 : 1;
  });
