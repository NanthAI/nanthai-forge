// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { policyPreset } from './autonomy-policy.js';
import { workSchema } from './work-types.js';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { materializeWork } from './work-hosted-index.js';

/** The same retained State/Work representation as an uploaded native checkpoint. */
export function emptyHostedProject(operationId: string, at: string) {
  const state = JSON.stringify({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [],
    message: 'Initial hosted source',
    at,
  });
  const head = digest(state);
  const data = workSchema.parse({
    schema: 11,
    revision: 0,
    autonomyPolicy: policyPreset('supervised'),
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
    channelMoves: [
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
    ],
  });
  const work = JSON.stringify(data, null, 2);
  const pin = (text: string) => ({ sha256: digest(text), size: new TextEncoder().encode(text).length });
  const manifest = nativeManifestSchema.parse({
    schema: 1,
    kind: 'forge-native-work-backup',
    id: operationId,
    head,
    revision: 0,
    files: [
      { path: 'work.json', ...pin(work) },
      { path: `objects/${head}`, ...pin(state) },
    ],
    unavailable: [],
    coverage: 'Empty hosted source and initialized Work; no source files.',
  });
  const manifestText = JSON.stringify(manifest);
  const parents = Object.assign(new Map([[head, [] as string[]]]), { files: new Map([[head, []]]) });
  const projection = materializeWork(data, manifest, [], 'objects', parents);
  return {
    head,
    data,
    manifest,
    projection,
    objects: [state, work, manifestText].map(text => ({ text, ...pin(text) })),
    preview: {
      manifestDigest: digest(manifestText),
      head,
      format: 'native' as const,
      revision: 0,
      intents: 0,
      lanes: 0,
      views: 0,
      runs: 0,
      files: 2,
      unavailable: 0,
      channels: [{ name: 'main', head }],
    },
  };
}
