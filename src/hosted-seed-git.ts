// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { filesFromGit, prepareNativeProjection } from './native-git.js';
import { NativeSource, nativeMarker } from './native-source.js';
import { workGit } from './work-git.js';
import { exportWork, copyPrivate } from './work-backup.js';
import { parseWorkBytes } from './work-metadata.js';
import { createWork } from './work-create.js';
import { invariant } from './errors.js';
import { manifestSchema, workSourcePins } from './work-archive-metadata.js';
import { WorkStore } from './work-store.js';
import { publishDirectory } from './state/durability.js';
import type { WorkData, DependencyPin } from './work-types.js';

type ExportStore = Parameters<typeof exportWork>[0];

/** A pinned Git host keeps its original owner and refs. The operation-private
 * native owner carries the same Work identities and the verified original Git bundle. */
export async function gitSeedOwner(store: ExportStore, head: string, revision: number, operationId: string) {
  const destination = join(store.directory, `host-native-${operationId}`);
  if (existsSync(destination)) {
    const owner = WorkStore.open<'load'>(destination);
    const work = owner.load();
    invariant(
      work.revision === revision &&
        work.nativeHead &&
        new NativeSource(destination).state(work.nativeHead).git?.commit === head,
      'WORK_OPERATION_CHANGED',
      'Resume the original Git hosting snapshot.',
    );
    return destination;
  }
  const exported = await exportWork(store, revision, false, head);
  const folder = exported.result.path;
  const scratch = mkdtempSync(join(store.directory, 'host-native-'));
  try {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')));
    const workBytes = readFileSync(join(folder, 'work.json'));
    const work = parseWorkBytes(workBytes);
    invariant(
      manifest.head === head && manifest.revision === revision && work.revision === revision,
      'WORK_OPERATION_CHANGED',
      'Verified Git source and Work differ from their hosting pins.',
    );
    const ownerPath = join(scratch, 'owner');
    mkdirSync(ownerPath, { mode: 0o700 });
    nativeMarker(ownerPath);
    const source = new NativeSource(ownerPath);
    const bundle = source.put(readFileSync(join(folder, 'source.bundle')));
    invariant(
      bundle === manifest.files.find(file => file.path === 'source.bundle')?.sha256,
      'INVALID_WORK_BACKUP',
      'The verified Git bundle changed before hosting.',
    );
    const states = new Map<string, string>();
    const state = (commit: string) => {
      const cached = states.get(commit);
      if (cached) return cached;
      const at = workGit(store.root, ['--no-replace-objects', 'show', '-s', '--format=%cI', commit]).trim();
      const snapshot = source.writeState(
        filesFromGit(store.root, commit, source),
        [],
        'Imported original Git source',
        at,
        { bundle, commit, format: manifest.format },
      );
      states.set(commit, snapshot);
      return snapshot;
    };
    const owner = WorkStore.open<'root' | 'native' | 'directory' | 'save'>(ownerPath);
    work.nativeHead = state(head);
    for (const commit of workSourcePins({ ...work, nativeHead: undefined })) state(commit);
    const dependencies = (pins: DependencyPin[] | undefined) => {
      for (const pin of pins ?? []) if (pin.kind === 'view') pin.head = state(pin.head);
    };
    for (const intent of work.intents) {
      if (intent.base) intent.base = state(intent.base);
      if (intent.mainCheckFailure) intent.mainCheckFailure.head = state(intent.mainCheckFailure.head);
      dependencies(intent.dependencies);
      for (const observation of intent.external?.observations ?? []) {
        const base = state(observation.base),
          observed = state(observation.head);
        const projection = await prepareNativeProjection(owner, observed);
        observation.bundle = bundle;
        observation.native = { base, head: observed, projection: projection.retain() };
      }
    }
    for (const lane of work.lanes) {
      lane.base = state(lane.base);
      lane.head = state(lane.head);
      if (lane.parent) lane.parent.head = state(lane.parent.head);
      for (const checkpoint of [...lane.checkpoints, lane.pending, lane.pendingSync]) {
        if (!checkpoint) continue;
        checkpoint.parent = state(checkpoint.parent);
        checkpoint.head = state(checkpoint.head);
      }
      for (const handover of lane.handovers ?? []) handover.head = state(handover.head);
    }
    for (const view of work.views) {
      view.base = state(view.base);
      if (view.head) view.head = state(view.head);
      if (view.composedMain) view.composedMain = state(view.composedMain);
      if (view.resolution) view.resolution.head = state(view.resolution.head);
      for (const pin of view.inputs) pin.head = state(pin.head);
      dependencies(view.dependencies);
    }
    for (const run of [...work.runs, ...work.playbookRuns]) {
      run.head = state(run.head);
      run.base = state(run.base);
      for (const pin of run.inputs) pin.head = state(pin.head);
      dependencies(run.dependencies);
    }
    retainGitWorkEvidence(work, state);
    for (const file of manifest.files) {
      if (file.path.startsWith('check-'))
        await copyPrivate(join(folder, file.path), join(owner.directory, file.path));
      if (file.path.startsWith('contribution-')) source.put(readFileSync(join(folder, file.path)));
    }
    owner.save(
      workBytes.equals(Buffer.from(JSON.stringify(createWork(), null, 2)))
        ? createWork(work.nativeHead)
        : work,
    );
    if (!existsSync(destination)) publishDirectory(ownerPath, destination);
    return destination;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function retainGitWorkEvidence(work: WorkData, state: (commit: string) => string) {
  for (const record of [...work.publications, ...work.githubChecks, ...work.reviews])
    record.head = state(record.head);
  for (const move of work.channelMoves) {
    move.head = state(move.head);
    if (move.previous) move.previous = state(move.previous);
  }
  for (const move of work.hostedChannelMoves ?? []) move.head = state(move.head);
  for (const release of work.releases) {
    release.acceptance.head = state(release.acceptance.head);
    for (const run of release.buildRuns ?? []) run.head = state(run.head);
  }
  for (const deployment of work.deployments) deployment.head = state(deployment.head);
  for (const move of work.environmentMoves) move.deployment.head = state(move.deployment.head);
}
