// SPDX-License-Identifier: Apache-2.0
import type { Config } from '@netlify/functions';
import { workerAuthorized } from '../../src/worker-auth.js';
import { authorizeGithub } from '../../src/github-access.js';
import { captureGithub, githubAnalysisVersion } from '../../src/github.js';
import { encodeHostedArtifact } from '../../src/hosted-artifact.js';
import { ForgeError, invariant } from '../../src/errors.js';

export default async (request: Request): Promise<Response> => {
  const key = process.env.FORGE_WORKER_KEY;
  console.info('Forge analysis worker received a request.', {
    keyConfigured: Boolean(key),
    callbackConfigured: Boolean(process.env.FORGE_CONVEX_SITE_URL),
  });
  if (!(await workerAuthorized(request.headers.get('authorization'), key))) {
    console.warn('Forge analysis worker authorization failed.');
    return new Response('Unauthorized', { status: 401 });
  }
  let job: { id: string; generation: number };
  try {
    job = await request.json();
    invariant(
      job && typeof job.id === 'string' && Number.isSafeInteger(job.generation) && job.generation > 0,
      'BAD_ARGUMENT',
      'Invalid worker job.',
    );
  } catch {
    console.warn('Forge analysis worker received an invalid job.');
    return new Response('Invalid worker job.', { status: 400 });
  }
  const post = async <T,>(operation: string, data: object): Promise<T> => {
    const response = await fetch(`${process.env.FORGE_CONVEX_SITE_URL}/worker/${operation}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok)
      console.error('Forge analysis callback failed.', { operation, status: response.status });
    invariant(response.ok, 'WORKER_UNAVAILABLE', 'The analysis worker could not update its job.');
    return response.json() as Promise<T>;
  };
  let artifactKey: string | undefined;
  try {
    const input = await post<{ repository: string; ref: string; uploadUrl: string } | null>('prepare', job);
    // A delivery must claim its generation once; platform redeliveries do not restart analysis.
    if (!input) return new Response(null, { status: 204 });
    const access = await authorizeGithub(input.repository, undefined, {
      publicToken: process.env.GITHUB_PUBLIC_TOKEN,
    });
    const artifact = await captureGithub(
      access.repository,
      input.ref,
      access.token,
      async (processed, total) => {
        const current = await post<boolean>('update', {
          ...job,
          phase: processed === total ? 'indexing' : 'fetching',
          processed,
          total,
        });
        invariant(current, 'WORKER_SUPERSEDED', 'A newer import replaced this worker.');
      },
    );
    const response = await fetch(input.uploadUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/gzip' },
      body: await encodeHostedArtifact(artifact),
    });
    invariant(response.ok, 'WORKER_UNAVAILABLE', 'The source artifact could not be stored.');
    const stored = (await response.json()) as { storageId: string };
    invariant(
      typeof stored.storageId === 'string',
      'INVALID_ARTIFACT',
      'Storage returned an invalid artifact identity.',
    );
    artifactKey = stored.storageId;
    await post<boolean>('update', {
      ...job,
      phase: 'ready',
      artifactKey,
      head: artifact.pack.source.gitHead,
      analysisVersion: githubAnalysisVersion(),
    });
  } catch (error) {
    console.error('Forge analysis worker failed.', {
      code: error instanceof ForgeError ? error.code : 'WORKER_UNAVAILABLE',
    });
    try {
      await post('update', {
        ...job,
        phase: 'error',
        ...(artifactKey ? { artifactKey } : {}),
        error:
          error instanceof ForgeError
            ? error.message
            : 'Import failed. Retry to rebuild; previous source is retained.',
      });
    } catch {
      /* The Convex watchdog reconciles a lost callback; do not restart the import. */
    }
  }
  return new Response(null, { status: 204 });
};
export const config: Config = { background: true };
