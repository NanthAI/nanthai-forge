// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAuth } from './auth-store.js';
import { deploymentUrl } from './deployment-origin.js';
import { ForgeError, invariant } from './errors.js';
import { networkFetch, networkTimeout } from './network-fetch.js';
import { cliDiscoveryPath, distributionForgeSite } from './forge-site.js';

type Auth = ReturnType<typeof readAuth>;

export function appUrl(value: string) {
  try {
    return deploymentUrl(value);
  } catch {
    throw new ForgeError('BAD_ARGUMENT', 'Use the Forge app URL over HTTPS or HTTP loopback.');
  }
}

export function savedApp(deployment: string, store: Auth = readAuth()) {
  return Object.entries(store.sites ?? {}).find(([, backend]) => backend === deployment)?.[0];
}

export function savedAppForDefault(store: Auth = readAuth()) {
  return store.defaultDeployment ? savedApp(store.defaultDeployment, store) : undefined;
}

async function discover(site: string) {
  try {
    const response = await networkFetch(
      site + cliDiscoveryPath,
      {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: networkTimeout(5_000),
      },
      { retries: 0 },
    );
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel();
      throw new Error('Missing Forge discovery asset.');
    }
    let contents = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.byteLength;
      if (size > 4096) throw new Error('Invalid Forge discovery asset.');
      contents += decoder.decode(chunk, { stream: true });
    }
    const { deployment } = JSON.parse(contents + decoder.decode());
    if (typeof deployment !== 'string') throw new Error('Invalid Forge discovery asset.');
    const backend = deploymentUrl(deployment);
    // Local backend addresses are meaningful only when the app is local too.
    if (new URL(backend).protocol === 'http:' && new URL(site).protocol !== 'http:')
      throw new Error('Invalid Forge discovery asset.');
    return backend;
  } catch {
    throw new ForgeError(
      'AUTH_UNAVAILABLE',
      `Could not find Forge at ${site}. Check the app URL and try again.`,
    );
  }
}

export async function appTarget(value: string, store: Auth = readAuth(), refresh = false) {
  const site = appUrl(value);
  const saved = store.sites?.[site];
  return { site, deployment: !refresh && saved ? deploymentUrl(saved) : await discover(site) };
}

export function backendTarget(value: string, store: Auth = readAuth()) {
  const deployment = deploymentUrl(value);
  return { deployment, site: savedApp(deployment, store) };
}

/** Keep explicit old backend URLs and the environment override for scripts and self-hosting. */
export function authTarget(value: string, store: Auth, refresh = false) {
  const origin = appUrl(value);
  const direct =
    Object.hasOwn(store.deployments, origin) ||
    origin === store.defaultDeployment ||
    origin === process.env.FORGE_DEPLOYMENT_URL?.replace(/\/$/, '') ||
    new URL(origin).hostname.endsWith('.convex.cloud') ||
    (new URL(origin).protocol === 'http:' && process.env.FORGE_HTTP_URL);
  return direct && !store.sites?.[origin] ? backendTarget(origin, store) : appTarget(origin, store, refresh);
}

export async function serviceTarget(
  options: { site?: string; deployment?: string },
  bound?: string,
  refresh = false,
) {
  invariant(!options.site || !options.deployment, 'BAD_ARGUMENT', 'Select one Forge app URL.');
  if (options.deployment) return { deployment: deploymentUrl(options.deployment), site: undefined };
  const store = readAuth();
  if (options.site) return appTarget(options.site, store, refresh);
  const deployment = bound ?? process.env.FORGE_DEPLOYMENT_URL ?? store.defaultDeployment;
  return deployment ? backendTarget(deployment, store) : appTarget(distributionForgeSite(), store, refresh);
}

/** Walk only local checkout markers, stopping at a repository boundary. No discovery or network call. */
export async function folderAddress() {
  let root = process.cwd();
  for (;;) {
    if (
      ['.forge/hosted-lane.json', '.forge/hosted-main.json', '.git', '.forge/native.json'].some(path =>
        existsSync(join(root, path)),
      )
    ) {
      const { hostedAgentAddress } = await import('./hosted-agent-address.js');
      return hostedAgentAddress(root, {});
    }
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}
