// SPDX-License-Identifier: Apache-2.0
// Run the actual CLI in its own process, separate from the in-memory Convex/R2
// server and its retained fixture bytes. Only synthetic bucket GETs are proxied.
import { readFileSync } from 'node:fs';
const nativeFetch = globalThis.fetch;
let peak = { rss: 0 },
  rpcCalls = 0;
const sample = phase => {
  const rss = process.memoryUsage.rss();
  if (rss > peak.rss) peak = { ...process.memoryUsage(), phase };
};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (/^\/api\/(?:query|mutation|action)$/.test(url.pathname)) rpcCalls++;
  sample('before fetch');
  const response = await nativeFetch(
    url.hostname === 'acct0123.r2.cloudflarestorage.com'
      ? `${process.env.FORGE_TEST_CHECKOUT_PROXY}/r2?url=${encodeURIComponent(url.href)}`
      : input,
    init,
  );
  sample('response headers');
  return response;
};
process.once('beforeExit', () => {
  sample('exit');
  process.stderr.write(
    JSON.stringify({ peakRssMiB: process.resourceUsage().maxRSS / 1024, rpcCalls, sampledMemory: peak }) +
      '\n',
  );
});
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await import(new URL(`../${manifest.bin.nforge}`, import.meta.url).href);
