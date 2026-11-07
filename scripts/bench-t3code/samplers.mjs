// SPDX-License-Identifier: Apache-2.0
// B1.5d outside-load record (S7/S8), identical in both arms: Mac load and memory every 30 s,
// the GitHub API budget before and after, and clock offsets to GitHub and Convex.
import { appendFileSync } from 'node:fs';
import { loadavg, freemem, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkFetch } from '../../dist/network-fetch.js';

const run = promisify(execFile);

export function startSampler(file, everyMs = 30_000) {
  const sample = () =>
    appendFileSync(
      file,
      JSON.stringify({
        at: new Date().toISOString(),
        load: loadavg().map(l => Number(l.toFixed(2))),
        freeMemGb: Number((freemem() / 2 ** 30).toFixed(2)),
        totalMemGb: Number((totalmem() / 2 ** 30).toFixed(1)),
      }) + '\n',
    );
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref();
  return { stop: () => (clearInterval(timer), sample()) };
}

export async function rateLimit() {
  try {
    const { stdout } = await run('gh', [
      'api',
      'rate_limit',
      '--jq',
      '{core: .resources.core.remaining, graphql: .resources.graphql.remaining}',
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Seconds the remote Date header is ahead of this Mac (1 s resolution). */
export async function clockOffsets(convexUrl) {
  const one = async url => {
    try {
      const before = Date.now();
      // One attempt: a retry would skew the measured round trip.
      const res = await networkFetch(url, { method: 'HEAD' }, { retries: 0 });
      const local = (before + Date.now()) / 2;
      return Math.round((Date.parse(res.headers.get('date')) - local) / 100) / 10;
    } catch {
      return null;
    }
  };
  return { github: await one('https://api.github.com'), convex: await one(convexUrl) };
}
