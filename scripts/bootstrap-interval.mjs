// SPDX-License-Identifier: Apache-2.0
// Median difference of interleaved A/B pairs with a 95% bootstrap interval.
// Method and rules: docs/agents/perf-claims.md.
// Usage: node scripts/bootstrap-interval.mjs [FILE] [--seed N] [--resamples N]
// Input (FILE or stdin): JSON array of per-pair differences (B minus A) [d1, d2, ...],
// or of pairs [[a1, b1], ...] / [{"a": a1, "b": b1}, ...] (difference = b minus a),
// or an object {"pairs": <either array>}.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_RESAMPLES = 10000;
export const DEFAULT_SEED = 1;
export const SMALL_SAMPLE_PAIRS = 11;

const finite = (value, what) => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${what} must be a finite number`);
  return value;
};

export function pairDifferences(input) {
  const list = Array.isArray(input) ? input : input?.pairs;
  if (!Array.isArray(list)) throw new Error('Input must be an array of pairs or {"pairs": [...]}');
  return list.map((item, index) => {
    const at = `pair ${index}`;
    if (Array.isArray(item)) {
      if (item.length !== 2) throw new Error(`${at} must be [a, b]`);
      return finite(item[1], at) - finite(item[0], at);
    }
    if (item && typeof item === 'object') return finite(item.b, `${at}.b`) - finite(item.a, `${at}.a`);
    return finite(item, at);
  });
}

// mulberry32: tiny seeded generator so a seed reproduces the interval exactly.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sortedMedian = sorted => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const byValue = (a, b) => a - b;

export function bootstrapInterval(input, { seed = DEFAULT_SEED, resamples = DEFAULT_RESAMPLES } = {}) {
  const differences = pairDifferences(input);
  const n = differences.length;
  if (n === 0) throw new Error('Need at least one pair');
  if (!Number.isInteger(resamples) || resamples < 1000)
    throw new Error('resamples must be an integer of at least 1000 (the method uses 10,000)');
  if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
  const random = seededRandom(seed);
  const medians = new Array(resamples);
  const draw = new Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) draw[i] = differences[Math.floor(random() * n)];
    medians[r] = sortedMedian(draw.slice().sort(byValue));
  }
  medians.sort(byValue);
  const lo = medians[Math.floor(0.025 * resamples)];
  const hi = medians[Math.ceil(0.975 * resamples) - 1];
  return {
    n,
    medianDifference: sortedMedian(differences.slice().sort(byValue)),
    ci95: [lo, hi],
    excludesZero: lo > 0 || hi < 0,
    resamples,
    seed,
    smallSample: n < SMALL_SAMPLE_PAIRS,
  };
}

function main(argv) {
  let file;
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') options.seed = Number(argv[++i]);
    else if (argv[i] === '--resamples') options.resamples = Number(argv[++i]);
    else if (!file) file = argv[i];
    else throw new Error('Usage: node scripts/bootstrap-interval.mjs [FILE] [--seed N] [--resamples N]');
  }
  const text = readFileSync(file ?? 0, 'utf8');
  process.stdout.write(`${JSON.stringify(bootstrapInterval(JSON.parse(text), options))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
