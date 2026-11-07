// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { deploymentOptions } from '../hosted-durability.mjs';
import { presign } from '../../dist/r2-presign.js';
import { networkFetch, networkTimeout } from '../../dist/network-fetch.js';

/** Only the pinned CLI's readonly inline query, table list and individual config
 * reads are reachable. Provider output is captured and never included in errors. */
export function deploymentReader(deployment, root, env = process.env, timeoutMs = 90_000) {
  if (
    !deployment.startsWith('dev:') ||
    /^(?:prod|preview|custom):/.test((env.CONVEX_DEPLOY_KEY ?? '').split('|')[0])
  )
    throw new Error('AUDIT_DEV_DEPLOYMENT_REQUIRED');
  const selection = deploymentOptions(deployment, env);
  async function cli(args) {
    const child = spawn(
      process.execPath,
      [resolve(root, 'node_modules/convex/bin/main.js'), ...args, ...selection.args],
      {
        cwd: root,
        env: selection.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '',
      stderr = '';
    child.stdout.on('data', b => {
      output += b;
    });
    child.stderr.on('data', b => {
      stderr += b;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), Math.min(timeoutMs, 90_000));
    let status;
    try {
      status = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
    } finally {
      clearTimeout(timeout);
    }
    if (status !== 0) throw new Error('AUDIT_READ_FAILED');
    return output.trim();
  }
  return {
    async tables() {
      return (await cli(['data'])).split(/\s+/).filter(Boolean);
    },
    async page(source) {
      return JSON.parse(await cli(['run', '--inline-query', source]));
    },
    async r2Config() {
      const config = {};
      for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
        config[key] = await cli(['env', 'get', key]);
        if (!config[key]) throw new Error('R2_NOT_CONFIGURED');
      }
      return config;
    },
  };
}
const tags = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);
const tag = (xml, name) => tags(xml, name)[0];
const unescape = s =>
  s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
/** One LIST (1000 object metadata entries) per page. Never HEAD per object. */
export async function listR2(config, accept, fetcher = networkFetch, remainingDollars = 1) {
  let cursor,
    pages = 0,
    objects = 0,
    responseBytes = 0;
  const seen = new Set();
  do {
    if (((pages + 1) * 4.5) / 1e6 > remainingDollars) throw new Error('AUDIT_ESTIMATE_EXCEEDED');
    const url = await presign({
      method: 'GET',
      host: `${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      path: `/${config.R2_BUCKET}/`,
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      query: {
        'list-type': '2',
        'max-keys': '1000',
        prefix: 'v1/',
        'encoding-type': 'url',
        ...(cursor ? { 'continuation-token': cursor } : {}),
      },
    });
    const response = await fetcher(url, { signal: networkTimeout(120_000) });
    if (!response.ok) throw new Error('AUDIT_R2_LIST_FAILED');
    const xml = await response.text();
    responseBytes += Buffer.byteLength(xml);
    pages++;
    for (const entry of tags(xml, 'Contents')) {
      const key = decodeURIComponent(unescape(tag(entry, 'Key'))),
        size = Number(tag(entry, 'Size'));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('AUDIT_R2_LIST_INVALID');
      accept(key, size);
      objects++;
    }
    if (tag(xml, 'IsTruncated') !== 'true') break;
    cursor = unescape(tag(xml, 'NextContinuationToken') ?? '');
    if (!cursor || seen.has(cursor)) throw new Error('AUDIT_CURSOR_STALLED');
    seen.add(cursor);
  } while (true);
  return { pages, objects, responseBytes };
}
