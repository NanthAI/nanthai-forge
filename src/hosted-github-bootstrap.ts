// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { createWork } from './work-create.js';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { materializeWork } from './work-hosted-index.js';
import { invariant } from './errors.js';
import { safeRelative } from './safe-relative.js';

export type GithubHostedFile = {
  path: string;
  blob: string;
  size: number;
  mode: 'file' | 'executable' | 'symlink' | 'gitlink';
};
export function githubHostedProject(
  operationId: string,
  at: string,
  commit: string,
  files: GithubHostedFile[],
) {
  invariant(
    files.every(
      file =>
        safeRelative(file.path) &&
        !file.path
          .toLowerCase()
          .split('/')
          .some(part => ['.git', '.forge'].includes(part)),
    ),
    'INVALID_NATIVE_SOURCE',
    'Imported paths cannot overlap native metadata.',
  );
  const entries = files
    .map(({ path, blob, mode }) => ({ path, blob, mode }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set(entries.map(file => file.path));
  invariant(
    paths.size === files.length &&
      entries.every(file =>
        file.path
          .split('/')
          .slice(0, -1)
          .every((_, index, parts) => !paths.has(parts.slice(0, index + 1).join('/'))),
      ),
    'INVALID_NATIVE_SOURCE',
    'Imported paths overlap.',
  );
  const state = JSON.stringify({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: entries,
    message: `Imported GitHub commit ${commit}`,
    at,
  });
  const head = digest(state);
  const data = githubImportedWork(operationId, at, head);
  const work = JSON.stringify(data, null, 2);
  const pin = (text: string) => ({ sha256: digest(text), size: new TextEncoder().encode(text).length });
  const source = new Map(files.map(file => [file.blob, file.size]));
  const manifest = nativeManifestSchema.parse({
    schema: 1,
    kind: 'forge-native-work-backup',
    id: operationId,
    head,
    revision: 0,
    files: [
      { path: 'work.json', ...pin(work) },
      { path: `objects/${head}`, ...pin(state) },
      ...[...source].map(([sha256, size]) => ({ path: `objects/${sha256}`, sha256, size })),
    ],
    unavailable: [],
    coverage: `Complete committed GitHub tree at ${commit}; original file bytes, executable bits, symlink targets and submodules kept as pointers. Git history, LFS target objects and analysis are separate.`,
  });
  const text = JSON.stringify(manifest);
  const parents = Object.assign(new Map([[head, [] as string[]]]), { files: new Map([[head, entries]]) });
  return {
    head,
    manifest,
    projection: materializeWork(data, manifest, [], 'objects', parents),
    objects: [state, work, text].map(text => ({ text, ...pin(text) })),
    preview: {
      manifestDigest: digest(text),
      head,
      format: 'native' as const,
      revision: 0,
      intents: 0,
      lanes: 0,
      views: 0,
      runs: 0,
      files: manifest.files.length,
      unavailable: 0,
      channels: [{ name: 'main', head }],
    },
  };
}

export function githubImportedWork(operationId: string, at: string, head: string) {
  const data = createWork(head);
  data.channelMoves = [
    {
      id: operationId,
      channel: 'main',
      viewId: operationId,
      head,
      previous: null,
      at,
      status: 'accepted',
      provenance: 'user-declared-local',
    },
  ];
  return data;
}
