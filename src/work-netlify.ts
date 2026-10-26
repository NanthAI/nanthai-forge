// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkEnvironment } from './work-run.js';
import { ForgeError, invariant } from './errors.js';
import type { Deployment } from './work-types.js';

const marker = (id: string) => `Forge draft ${id}`;
async function cli(directory: string, args: string[]): Promise<unknown> {
  const env = {
    ...checkEnvironment().env,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    CI: 'true',
    NETLIFY_CLI_TELEMETRY_DISABLED: '1',
    ...(process.env.NETLIFY_AUTH_TOKEN ? { NETLIFY_AUTH_TOKEN: process.env.NETLIFY_AUTH_TOKEN } : {}),
  };
  return new Promise((resolve, reject) => {
    // Native CLI owns credentials. The isolated directory contains no target package, hooks or functions.
    execFile(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['--yes', '--package=netlify-cli@27.10.2', 'netlify', ...args],
      { cwd: directory, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error)
          return reject(
            new ForgeError(
              'NETLIFY_UNAVAILABLE',
              'Netlify could not confirm this request with current CLI access. Original files and operation are retained; reconcile without another upload.',
            ),
          );
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new ForgeError(
              'NETLIFY_UNAVAILABLE',
              'Netlify returned an invalid response; reconcile the original operation.',
            ),
          );
        }
      },
    );
  });
}
export async function uploadDraft(directory: string, deployment: Deployment) {
  await cli(directory, [
    'deploy',
    '--no-build',
    '--draft',
    '--dir',
    'public',
    '--functions',
    'empty-functions',
    '--skip-functions-cache',
    '--site',
    deployment.siteId,
    '--message',
    marker(deployment.id),
    '--json',
  ]);
}
type ProviderDeploy = {
  id: string;
  site_id: string;
  title: string;
  state: string;
  context?: string;
  published_at?: string | null;
  deploy_ssl_url?: string;
};
export async function observeDraft(
  directory: string,
  deployment: Deployment,
): Promise<NonNullable<Deployment['observation']>> {
  let item: ProviderDeploy | undefined;
  if (deployment.providerId) {
    item = (await cli(directory, [
      'api',
      'getDeploy',
      '--data',
      JSON.stringify({ deploy_id: deployment.providerId }),
    ])) as ProviderDeploy;
    invariant(
      item?.id === deployment.providerId && item.site_id === deployment.siteId,
      'DEPLOYMENT_CHANGED',
      'The original provider deployment identity changed.',
    );
  } else {
    const found: ProviderDeploy[] = [],
      seen = new Set<string>();
    for (let page = 1; ; page++) {
      const items = await cli(directory, [
        'api',
        'listSiteDeploys',
        '--data',
        JSON.stringify({ site_id: deployment.siteId, per_page: 100, page }),
      ]);
      invariant(Array.isArray(items), 'NETLIFY_UNAVAILABLE', 'Netlify returned an invalid deployment page.');
      for (const item of items as ProviderDeploy[]) {
        invariant(
          typeof item.id === 'string' && item.site_id === deployment.siteId && !seen.has(item.id),
          'DEPLOYMENT_CHANGED',
          'Netlify deployment pagination changed; original operation is retained.',
        );
        seen.add(item.id);
        if (item.title === marker(deployment.id)) found.push(item);
      }
      if (items.length < 100) break;
    }
    invariant(
      found.length <= 1,
      'DEPLOYMENT_CHANGED',
      'Multiple provider deployments name this original operation. Inspect them; no upload was repeated.',
    );
    item = found[0];
  }
  if (!item)
    return {
      at: new Date().toISOString(),
      providerId: null,
      state: 'unconfirmed',
      context: null,
      publishedAt: null,
      url: null,
      files: [],
    };
  invariant(
    /^[a-f0-9]{24}$/.test(item.id) && typeof item.state === 'string',
    'NETLIFY_UNAVAILABLE',
    'Netlify returned invalid deployment metadata.',
  );
  const url = draftUrl(item.id, item.deploy_ssl_url);
  const files: NonNullable<Deployment['observation']>['files'] = [];
  for (const file of deployment.files) {
    const observed: (typeof files)[number] = { path: file.path, status: 'unconfirmed' };
    if (item.state === 'ready' && url) {
      try {
        const response = await fetch(new URL(file.path.split('/').map(encodeURIComponent).join('/'), url), {
          redirect: 'manual',
          signal: AbortSignal.timeout(120_000),
        });
        observed.httpStatus = response.status;
        const hash = createHash('sha256');
        let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              hash.update(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        observed.size = size;
        observed.sha256 = hash.digest('hex');
        if (response.status === 200 && size === file.size && observed.sha256 === file.sha256)
          observed.status = 'verified';
      } catch {
        /* Provider readiness and exact selected bytes remain independent; failures are unconfirmed. */
      }
    }
    files.push(observed);
  }
  return {
    at: new Date().toISOString(),
    providerId: item.id,
    state: item.state,
    context: item.context ?? null,
    publishedAt: item.published_at ?? null,
    url: url?.href ?? null,
    files,
  };
}

export function draftUrl(providerId: string, value?: string) {
  let url: URL | undefined;
  if (value) {
    try {
      url = new URL(value);
    } catch {
      /* Invalid provider URLs are never used for reads. */
    }
    invariant(
      url?.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        url.hostname.startsWith(`${providerId}--`) &&
        url.hostname.endsWith('.netlify.app'),
      'NETLIFY_UNAVAILABLE',
      'Netlify returned an unexpected draft URL.',
    );
  }
  return url;
}
