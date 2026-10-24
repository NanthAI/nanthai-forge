// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { filesFromGit, prepareNativeProjection, treeForGit, validateNativeProjection } from './native-git.js';
import { observe, prLocation, readPull } from './work-import.js';
import { workSourcePins } from './work-archive-metadata.js';
import { workGit } from './work-git.js';
import { parseWorkBytes, validateWorkSize } from './work-metadata.js';
import type { GitProjection, GithubObservation, WorkData } from './work-types.js';
import type { WorkStore } from './work-store.js';

function readWork(store: WorkStore) {
  const bytes = store.snapshotBytes();
  invariant(bytes, 'INVALID_WORK_STORE', 'Original native Work metadata is unavailable.');
  return parseWorkBytes(bytes);
}

export function nativeGitBindings(store: WorkStore, data: WorkData, mapping: Buffer) {
  const source = new NativeSource(store.root),
    ancestry = source.ancestry(),
    known = new Map<string, string>();
  const add = (commit: string, state: string) => {
    const previous = known.get(commit);
    if (!previous || (source.state(state).git?.commit === commit && ancestry.contains(state, previous)))
      known.set(commit, state);
  };
  const addMapping = (bytes: Buffer) => {
    const records = JSON.parse(bytes.toString('utf8')).states as { state: string; commit: string }[];
    for (const record of records) {
      source.state(record.state);
      add(record.commit, record.state);
    }
  };
  addMapping(mapping);
  const projections = [...data.publications, ...data.githubChecks].flatMap(item =>
    item.projection ? [item.projection] : [],
  );
  for (const intent of data.intents)
    for (const observation of intent.external?.observations ?? [])
      if (observation.native) projections.push(observation.native.projection);
  for (const projection of projections) {
    validateNativeProjection(store, projection.state, projection);
    addMapping(source.object(projection.mapping));
  }
  const pending = workSourcePins(data),
    seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const state = source.state(id);
    if (state.git) add(state.git.commit, id);
    pending.push(...state.parents);
  }
  return known;
}

// Translate selected snapshots only. Intervening commits and original authors,
// timestamps/signatures remain byte-exact in the complete Git bundle. Native
// parents are existing boundaries actually encountered in that commit's DAG.
export function nativeGitSnapshots(
  store: WorkStore,
  path: string,
  observation: Pick<GithubObservation, 'head' | 'base' | 'at'>,
  bundle: Buffer,
  projection: GitProjection,
  known: Map<string, string>,
  stage: NativeSource,
  options: { baseState?: string; label?: string } = {},
) {
  const original = new NativeSource(store.root);
  const bundleId = stage.put(bundle),
    stagedStates = new Set<string>();
  const owner = (id: string) => (stagedStates.has(id) ? stage : original);
  const graph = new Map(
    workGit(path, ['--no-lazy-fetch', 'rev-list', '--parents', observation.head, observation.base])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [id, ...parents] = line.split(' ');
        return [id!, parents] as const;
      }),
  );
  const select = (commit: string): string => {
    const existing = known.get(commit);
    if (existing && owner(existing).state(existing).git?.commit === commit) {
      const selectedOwner = owner(existing);
      invariant(
        workGit(path, ['--no-lazy-fetch', 'rev-parse', `${commit}^{tree}`]).trim() ===
          treeForGit(path, selectedOwner.state(existing).files, selectedOwner),
        'INVALID_NATIVE_GIT',
        'The selected Git commit differs from its retained native snapshot.',
      );
      return existing;
    }
    const pending = [commit],
      seen = new Set<string>(),
      parents = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const boundary = known.get(id);
      if (boundary) {
        // Equality of IDs or metadata alone is not a source/ancestry proof.
        const boundaryOwner = owner(boundary),
          snapshot = boundaryOwner.state(boundary);
        invariant(
          workGit(path, ['--no-lazy-fetch', 'rev-parse', `${id}^{tree}`]).trim() ===
            treeForGit(path, snapshot.files, boundaryOwner),
          'INVALID_NATIVE_GIT',
          'A retained native/Git boundary differs from its original source tree.',
        );
        stage.put(boundaryOwner.object(boundary));
        parents.add(boundary);
      } else {
        invariant(
          graph.has(id),
          'INVALID_NATIVE_GIT',
          'Fetched PR ancestry is incomplete; original Work is retained.',
        );
        pending.push(...graph.get(id)!);
      }
    }
    const files = filesFromGit(path, commit, stage);
    const head = stage.writeState(
      files,
      [...parents].sort(),
      `${options.label ?? 'Imported GitHub PR snapshot'} ${commit}`,
      observation.at,
      { bundle: bundleId, commit, format: projection.format },
    );
    // The base conversion can become the head's boundary only if the actual
    // Git DAG encounters its exact original commit.
    known.set(commit, head);
    stagedStates.add(head);
    return head;
  };
  const base = options.baseState ?? select(observation.base);
  const head = select(observation.head);
  return { native: { head, base, projection }, objects: readdirSync(stage.directory) };
}

export async function nativeGithubWork(
  store: WorkStore,
  command: { action: 'import-pr'; url: string } | { action: 'check-pr'; intentId: string },
  revision: number,
) {
  const selected = command.action === 'import-pr' ? prLocation(command.url) : undefined;
  const start = store.locked(() => {
    const data = readWork(store),
      intent =
        command.action === 'check-pr'
          ? data.intents.find(item => item.id === command.intentId)
          : data.intents.find(
              item =>
                item.external?.repository.toLowerCase() === selected!.repository.toLowerCase() &&
                item.external.number === selected!.number,
            );
    invariant(command.action !== 'check-pr' || intent?.external, 'NOT_FOUND', 'External Intent not found.');
    if (!intent) {
      invariant(data.revision === revision, 'WORK_STALE', 'Work changed. Refresh before importing a new PR.');
    }
    const accepted = data.channelMoves.filter(move => move.status === 'accepted');
    return {
      data,
      id: intent?.id ?? randomUUID(),
      count: intent?.external?.observations.length ?? 0,
      repository: intent?.external?.repository ?? selected!.repository,
      number: intent?.external?.number ?? selected!.number,
      head:
        accepted.filter(move => move.channel === 'main').at(-1)?.head ??
        accepted.at(-1)?.head ??
        data.nativeHead!,
    };
  });
  const pull = await readPull(store, start.repository, start.number);
  const projected = await prepareNativeProjection(store, start.head);
  const known = nativeGitBindings(store, start.data, projected.mapping);
  const staging = mkdtempSync(join(store.directory, 'incoming-pr-')),
    stage = new NativeSource(staging);
  try {
    let staged: ReturnType<typeof nativeGitSnapshots> | undefined;
    const observed = await observe(
      store,
      pull,
      true,
      true,
      projected.projection,
      projected.bundle,
      (path, observation, bundle) => {
        staged = nativeGitSnapshots(store, path, observation, bundle, projected.projection, known, stage);
      },
    );
    const observation = { ...observed };
    delete observation.stagedBundle;
    invariant(staged, 'INVALID_NATIVE_GIT', 'Native PR source was not retained.');
    const captured = staged;
    return store.locked(() => {
      const data = readWork(store);
      let intent =
        data.intents.find(item => item.id === start.id) ??
        data.intents.find(
          item =>
            item.external?.repository.toLowerCase() === start.repository.toLowerCase() &&
            item.external.number === start.number,
        );
      if (intent) {
        invariant(
          intent.external,
          'PUBLICATION_CHANGED',
          'External Intent identity changed. Original Work is retained.',
        );
        if (intent.external.observations.length !== start.count)
          return { revision: data.revision, result: intent };
      }
      const incoming = { ...observation, native: captured.native };
      if (!intent) {
        intent = {
          id: start.id,
          outcome: pull.title,
          constraints: '',
          base: incoming.native.base,
          status: 'active',
          notes: [],
          createdAt: incoming.at,
          external: {
            repository: pull.base.repo.full_name,
            number: pull.number,
            url: pull.html_url,
            author: pull.user,
            observations: [incoming],
          },
        };
        data.intents.push(intent);
      } else intent.external!.observations.push(incoming);
      if (data.schema < 5) data.schema = 5;
      data.revision++;
      validateWorkSize(data);
      const source = new NativeSource(store.root);
      // Reference registration and CAS insertion share the existing lock/owner.
      projected.retain();
      for (const id of captured.objects)
        invariant(
          source.put(stage.object(id)) === id,
          'INVALID_NATIVE_GIT',
          'An original PR object changed.',
        );
      store.save(data);
      return { revision: data.revision, result: intent };
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
