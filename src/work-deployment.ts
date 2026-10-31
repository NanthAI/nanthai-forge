// SPDX-License-Identifier: Apache-2.0
import { constants, copyFileSync, mkdirSync, chmodSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest } from './hash.js';
import { safeRelative, fingerprintPrivateFile } from './files.js';
import { inspectArtifacts } from './work-artifacts.js';
import { retainedAcceptance } from './work-channel.js';
import { executionGuard } from './work-git.js';
import { runOutputDirectory } from './work-run.js';
import { invariant } from './errors.js';
import { draftUrl, observeDraft, uploadDraft } from './work-netlify.js';
import type { WorkStore } from './work-store.js';
import type { Deployment, DeploymentCommand, EnvironmentCommand, WorkData } from './work-types.js';
import { forgeTempDir } from './forge-disk.js';

export async function deploymentWork(store: WorkStore, command: DeploymentCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  const original = store.locked(() => {
    if (!store.native) executionGuard(store.root);
    const data = store.load();
    if (command.action === 'check-deployment') {
      const saved = data.deployments.find(item => item.id === command.id);
      invariant(saved, 'NOT_FOUND', 'Select an existing deployment operation.');
      return saved;
    }
    const request = digest(JSON.stringify(command)),
      existing = data.deployments.find(item => item.id === command.operationId);
    if (existing) {
      invariant(
        existing.request === request,
        'WORK_OPERATION_CHANGED',
        'Reconcile the original deployment release, site and file mapping.',
      );
      return existing;
    }
    invariant(
      data.revision === revision,
      'WORK_STALE',
      'Work changed. Refresh before selecting a new deployment.',
    );
    const release = data.releases.find(item => item.id === command.releaseId);
    invariant(
      release?.acceptance.status === 'accepted' &&
        release.acceptance.head === command.expectedHead &&
        retainedAcceptance(store, data, release.acceptance),
      'RELEASE_CHANGED',
      'Select an original accepted source release and its retained source.',
    );
    const paths = new Set<string>();
    const files = command.files.map(selected => {
      invariant(
        safeRelative(selected.path) &&
          ![...paths].some(
            path =>
              path === selected.path ||
              path.startsWith(`${selected.path}/`) ||
              selected.path.startsWith(`${path}/`),
          ),
        'BAD_ARGUMENT',
        'Select distinct contained file paths without file/directory collisions.',
      );
      paths.add(selected.path);
      const run = release.buildRuns?.find(item => item.id === selected.runId),
        file = run?.artifacts?.find(
          item => item.sourcePath === selected.sourcePath && item.status === 'retained',
        );
      invariant(
        run?.endedAt &&
          run.head === release.acceptance.head &&
          run.viewId === release.acceptance.viewId &&
          file?.status === 'retained',
        'RELEASE_CHANGED',
        'Select retained files from original finished runs in this source release.',
      );
      return { ...selected, size: file.size, sha256: file.sha256 };
    });
    const deployment: Deployment = {
      id: command.operationId,
      request,
      releaseId: release.id,
      releaseDefinition: digest(JSON.stringify(release)),
      head: command.expectedHead,
      siteId: command.siteId,
      files,
      at: new Date().toISOString(),
      observationSequence: 0,
    };
    data.deployments.push(deployment);
    data.revision++;
    store.save(data);
    return deployment;
  });
  if (command.action === 'deploy-release' && !original.attemptedAt) {
    const directory = realpathSync(forgeTempDir('netlify'));
    chmodSync(directory, 0o700);
    // Staging owns bytes only; the existing WorkStore journals the sole upload attempt before any provider write.
    mkdirSync(join(directory, 'public'), { mode: 0o700 });
    mkdirSync(join(directory, 'empty-functions'), { mode: 0o700 });
    writeFileSync(
      join(directory, 'netlify.toml'),
      '[build]\ncommand = ""\npublish = "public"\n[functions]\ndirectory = "empty-functions"\n',
      { mode: 0o600 },
    );
    try {
      const release = store.load().releases.find(item => item.id === original.releaseId);
      invariant(
        release,
        'RELEASE_CHANGED',
        'The original source release is unavailable; nothing was uploaded.',
      );
      for (const file of original.files) {
        const run = release.buildRuns?.find(item => item.id === file.runId);
        invariant(run, 'RELEASE_CHANGED', 'The original release run is unavailable; nothing was uploaded.');
        const source = (
          await inspectArtifacts(runOutputDirectory(store, run.id), {
            ...run,
            artifacts: (run.artifacts ?? []).filter(item => item.sourcePath === file.sourcePath),
          })
        ).find(item => item.sourcePath === file.sourcePath);
        invariant(
          source?.size === file.size && source.sha256 === file.sha256,
          'ARTIFACT_CHANGED',
          'Original selected output changed; nothing was uploaded.',
        );
        const path = join(directory, 'public', file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        copyFileSync(source.path, path, constants.COPYFILE_EXCL);
        chmodSync(path, 0o600);
        const copied = await fingerprintPrivateFile(path, 'ARTIFACT_CHANGED');
        invariant(
          copied.size === file.size && copied.sha256 === file.sha256,
          'ARTIFACT_CHANGED',
          'Prepared output differs from the original run; nothing was uploaded.',
        );
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    const attempt = store.locked(() => {
      if (!store.native) executionGuard(store.root);
      const data = store.load(),
        saved = data.deployments.find(item => item.id === original.id);
      invariant(
        saved?.request === original.request,
        'DEPLOYMENT_CHANGED',
        'Original deployment metadata changed.',
      );
      if (saved.attemptedAt) return false;
      const current = data.releases.find(item => item.id === saved.releaseId);
      invariant(
        current &&
          digest(JSON.stringify(current)) === saved.releaseDefinition &&
          current.acceptance.head === saved.head &&
          retainedAcceptance(store, data, current.acceptance),
        'RELEASE_CHANGED',
        'Original release or accepted source changed before upload; prepared files are retained.',
      );
      saved.directory = directory;
      saved.attemptedAt = new Date().toISOString();
      data.revision++;
      store.save(data);
      return true;
    });
    if (attempt) {
      try {
        await uploadDraft(directory, original);
      } catch {
        /* Unknown CLI outcomes are reconciled by the original provider marker, never another upload. */
      }
    } else rmSync(directory, { recursive: true, force: true });
  }
  const selected = store.locked(() => {
    const data = store.load(),
      saved = data.deployments.find(item => item.id === original.id);
    invariant(
      saved?.request === original.request,
      'DEPLOYMENT_CHANGED',
      'Original deployment metadata changed.',
    );
    if (!saved.attemptedAt) return saved;
    saved.observationSequence++;
    data.revision++;
    store.save(data);
    return saved;
  });
  if (!selected.attemptedAt) return { revision: store.load().revision, result: selected };
  // Read-only CLI calls use another fresh directory: retained upload files/config can never become executable input.
  const directory = realpathSync(forgeTempDir('netlify-read'));
  chmodSync(directory, 0o700);
  try {
    const observation = await observeDraft(directory, selected);
    return store.locked(() => {
      const data = store.load(),
        saved = data.deployments.find(item => item.id === selected.id);
      invariant(
        saved?.request === selected.request,
        'DEPLOYMENT_CHANGED',
        'Original deployment metadata changed.',
      );
      invariant(
        !saved.providerId || saved.providerId === observation.providerId,
        'DEPLOYMENT_CHANGED',
        'The original provider identity changed; its receipt is retained.',
      );
      if (saved.observationSequence === selected.observationSequence) {
        if (observation.providerId && !saved.providerId) {
          saved.providerId = observation.providerId;
          saved.providerConfirmedAt = observation.at;
        }
        saved.observation = observation;
        data.revision++;
        store.save(data);
      }
      return { revision: data.revision, result: saved };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ponytail: retained move history is scanned once; index it only if measured WorkStore size warrants it.
export function previewEnvironments(data: WorkData) {
  return [...new Map(data.environmentMoves.map(move => [move.name, move])).values()];
}
export function selectPreviewEnvironment(store: WorkStore, command: EnvironmentCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  return store.locked(() => {
    if (!store.native) executionGuard(store.root);
    const data = store.load(),
      request = digest(JSON.stringify(command));
    const existing = data.environmentMoves.find(move => move.id === command.operationId);
    if (existing) {
      invariant(
        existing.request === request,
        'WORK_OPERATION_CHANGED',
        'Reconcile the original environment name, draft and previous selection.',
      );
      return { revision: data.revision, result: existing };
    }
    invariant(
      data.revision === revision,
      'WORK_STALE',
      'Work changed. Refresh before changing an environment.',
    );
    const previous = previewEnvironments(data).find(move => move.name === command.name);
    invariant(
      (previous?.id ?? null) === command.expectedPrevious,
      'ENVIRONMENT_CHANGED',
      'The environment selection changed. Refresh its current draft; nothing was overwritten.',
    );
    const deployment = data.deployments.find(item => item.id === command.deploymentId),
      observation = deployment?.observation;
    invariant(
      deployment?.providerId && observation?.providerId === deployment.providerId && observation.url,
      'DEPLOYMENT_UNCONFIRMED',
      'Select a retained draft with its original provider identity and URL. Readiness and bytes remain separate.',
    );
    draftUrl(deployment.providerId, observation.url);
    const move = {
      id: command.operationId,
      request,
      name: command.name,
      previous: command.expectedPrevious,
      at: new Date().toISOString(),
      deployment: {
        id: deployment.id,
        releaseId: deployment.releaseId,
        releaseDefinition: deployment.releaseDefinition,
        head: deployment.head,
        siteId: deployment.siteId,
        files: structuredClone(deployment.files),
        providerId: deployment.providerId,
        observation: structuredClone(observation),
      },
    };
    data.environmentMoves.push(move);
    data.revision++;
    store.save(data);
    return { revision: data.revision, result: move };
  });
}
