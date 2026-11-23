// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Mock check by API (Item 3bd3eb0f). A UI Lane with a design mock runs this in its one review round instead
// of opening the mock and screenshots in a subscription session: one Anthropic Messages API call with the
// mock images, the Lane's screenshots and the Item's design lines; it returns each mismatch (where, what the
// mock shows, what the build shows, severity), tokens and dollars. Claude on purpose: a visual comparison
// against a fixed picture, not a code review, so the other-family rule does not apply.
//
//   node scripts/review-mock.mjs --mock MOCK.png [--mock …] --shot SHOT.png [--shot …] [--lane LANE_PATH
//     --item ITEM_ID] [--tier core|standard] [--model M] [--effort low|medium|high] [--max-call-usd N]
//     [--max-day-usd N] [--max-output-tokens N] [--spend-log FILE] [--config FILE] [--dry-run] [--json]
//
// Same key, caps and spend log as scripts/review-api.mjs (docs/agents/review-api.md), which also runs this
// check from its own flags (--mock/--shot) on the Item it already read. Alone, --item costs one `planning` read. PNG/JPEG only; larger images are downscaled first.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planFor, call } from './review-api-route.mjs';
import { realDeps } from './review-api-deps.mjs';
import { readItem } from './review-api-item.mjs';
import { DEFAULTS, ReviewError, mergeConfig, spentOn, tierFromText } from './review-api-lib.mjs';
import {
  MISMATCH_SCHEMA,
  MOCK_INSTRUCTIONS,
  MOCK_LIMITS,
  formatMock,
  imageInfo,
  imageTokens,
  mockContent,
  needsDownscale,
  parseMismatches,
  textBytes,
} from './review-mock-lib.mjs';

const VALUE_FLAGS = new Set([
  'lane',
  'item',
  'tier',
  'model',
  'effort',
  'max-call-usd',
  'max-day-usd',
  'max-output-tokens',
  'price-in',
  'price-out',
  'spend-log',
  'config',
  'image-bytes',
]);

export function parseMockArgs(argv) {
  const args = { mock: [], shot: [] };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) throw new ReviewError('REVIEW_ARGS', `Unexpected argument ${argv[i]}.`);
    if (name === 'mock' || name === 'shot') args[name].push(argv[++i]);
    else if (VALUE_FLAGS.has(name)) args[name] = argv[++i];
    else if (['dry-run', 'json'].includes(name)) args[name] = true;
    else throw new ReviewError('REVIEW_ARGS', `Unknown flag --${name}.`);
  }
  return args;
}

/** The image edges of the mock check: a regular file (no symlink), downscaled with macOS `sips`. */
export const imageDeps = {
  readImage(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 50_000_000)
      throw new ReviewError('REVIEW_IMAGE', `${basename(path)} is not a regular image file under 50 MB.`);
    return readFileSync(path);
  },
  /** Longest edge to `maxEdge`; `jpeg` re-encodes at quality 80 when a PNG stays too large. */
  downscale(buf, info, { maxEdge, jpeg }) {
    const dir = mkdtempSync(join(tmpdir(), 'review-mock-'));
    try {
      const [from, to] = [join(dir, 'in'), join(dir, jpeg ? 'out.jpg' : 'out')];
      writeFileSync(from, buf);
      const format = jpeg ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80'] : [];
      execFileSync('sips', [...format, '-Z', String(maxEdge), from, '--out', to], { stdio: 'ignore' });
      return readFileSync(to);
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw new ReviewError(
        'REVIEW_IMAGE',
        `Cannot downscale a ${info.width}x${info.height} image (macOS sips is needed); pass images within ${maxEdge}px.`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

function loadImage(path, deps, limits) {
  if (!['.png', '.jpg', '.jpeg'].includes(extname(path ?? '').toLowerCase()))
    throw new ReviewError('REVIEW_IMAGE', `${path ?? '(missing)'} is not a .png, .jpg or .jpeg file.`);
  let data;
  try {
    data = deps.readImage(path);
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError('REVIEW_IMAGE', `Cannot read ${basename(path)}: ${error?.code ?? 'error'}.`);
  }
  let info = imageInfo(data);
  if (!info) throw new ReviewError('REVIEW_IMAGE', `${basename(path)} is not a PNG or JPEG image.`);
  for (const jpeg of [false, true]) {
    if (!needsDownscale(info, data.length, limits)) break;
    data = deps.downscale(data, info, { maxEdge: limits.maxEdge, jpeg });
    info = imageInfo(data);
    if (!info) throw new ReviewError('REVIEW_IMAGE', `${basename(path)} could not be downscaled.`);
  }
  if (needsDownscale(info, data.length, limits))
    throw new ReviewError('REVIEW_IMAGE_BUDGET', `${basename(path)} is still over the image limits.`);
  return { name: basename(path), data, ...info };
}

export async function reviewMock(argv, defaults = { ...realDeps, ...imageDeps }) {
  const args = parseMockArgs(argv);
  return reviewMockWith(args, args['spend-log'] ? { ...defaults, spendLog: args['spend-log'] } : defaults);
}

/** The check itself. `preload` ({text, notes}) is an Item the caller already read (review-api.mjs), so the
 * round stays at one `planning` read; without it `--item` reads it. */
export async function reviewMockWith(args, deps, preload) {
  deps = { ...imageDeps, ...deps };
  args = { ...args, mock: args.mock ?? [], shot: args.shot ?? [] };
  if (!args.mock.length || !args.shot.length)
    throw new ReviewError(
      'REVIEW_ARGS',
      'Pass at least one --mock IMAGE (the design) and one --shot IMAGE (the build).',
    );
  if (args.item && !args.lane) throw new ReviewError('REVIEW_ARGS', '--item needs --lane LANE_PATH.');
  const number = (value, fallback, flag) => {
    if (value === undefined) return fallback;
    if (!(Number(value) >= 0)) throw new ReviewError('REVIEW_ARGS', `--${flag} must be a number.`);
    return Number(value);
  };
  const limits = {
    ...MOCK_LIMITS,
    budgetBytes: number(args['image-bytes'], MOCK_LIMITS.budgetBytes, 'image-bytes'),
  };
  if (args.mock.length + args.shot.length > limits.maxImages)
    throw new ReviewError('REVIEW_IMAGE_BUDGET', `At most ${limits.maxImages} images per check.`);
  const config = mergeConfig(deps.localConfig(args.config));
  const [mocks, shots] = [args.mock, args.shot].map(paths => paths.map(p => loadImage(p, deps, limits)));
  const images = [...mocks, ...shots];
  const bytes = images.reduce((sum, image) => sum + image.data.length, 0);
  if (bytes > limits.budgetBytes)
    throw new ReviewError(
      'REVIEW_IMAGE_BUDGET',
      `The images total ${bytes} bytes after downscaling, over the ${limits.budgetBytes} byte budget; pass fewer or smaller images.`,
    );
  const read = preload ?? (args.item ? await readItem(deps, args.lane, args.item) : { text: '', notes: [] });
  const tier = args.tier ?? tierFromText(read.text) ?? 'standard';
  if (!['core', 'standard'].includes(tier))
    throw new ReviewError('REVIEW_ARGS', '--tier must be core or standard.');
  const route = { provider: 'anthropic', model: args.model ?? config.providers.anthropic.models[tier] };
  const content = mockContent({ item: read.text, mocks, shots, notes: read.notes });
  // Only a missing log means no spend yet; an unreadable one refuses rather than count as $0.
  const readLog = () => (existsSync(deps.spendLog) ? readFileSync(deps.spendLog, 'utf8') : '');
  const ctx = {
    args,
    deps,
    config,
    input: { laneId: null },
    system: MOCK_INSTRUCTIONS,
    user: content,
    tier,
    promptBytes: textBytes(content) + Buffer.byteLength(MOCK_INSTRUCTIONS),
    extraInputTokens: images.reduce((sum, image) => sum + imageTokens(image), 0),
    maxOutputTokens: number(args['max-output-tokens'], DEFAULTS.maxOutputTokens, 'max-output-tokens'),
    maxCallUsd: number(args['max-call-usd'], DEFAULTS.maxCallUsd, 'max-call-usd'),
    dayCapFlag: args['max-day-usd'] === undefined ? undefined : number(args['max-day-usd'], 0, 'max-day-usd'),
    priceOverride: {
      input: number(args['price-in'], undefined, 'price-in'),
      output: number(args['price-out'], undefined, 'price-out'),
    },
    day: deps.now().toISOString().slice(0, 10),
    readLog,
    callOptions: {
      schema: MISMATCH_SCHEMA,
      schemaName: 'mock_mismatches',
      parse: parseMismatches,
      purpose: 'mock',
    },
  };
  const plan = planFor(ctx, route);
  plan.capsFor(); // a cap breach refuses before any key is read or image sent; there is no second provider
  if (args['dry-run'])
    return deps.out(
      `Dry run: ${images.length} images (${bytes} bytes), worst case $${plan.estimate.toFixed(3)} on ${route.provider}/${route.model} (tier ${tier}); nothing sent.`,
    );
  const done = await call(ctx, route, plan);
  const meta = {
    model: route.model,
    images: images.length,
    usage: done.usage,
    usd: done.usd,
    spentTodayUsd: spentOn(ctx.day, readLog(), 'anthropic'),
  };
  return deps.out(
    args.json ? JSON.stringify({ ...done.parsed, ...meta, tier }) : formatMock(done.parsed, meta),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  reviewMock(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.code ?? 'REVIEW_ERROR'}: ${error.message}\n`);
    process.exitCode = error instanceof ReviewError ? 2 : 1;
  });
