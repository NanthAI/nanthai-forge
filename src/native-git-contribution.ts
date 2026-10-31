// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { digest } from './hash.js';
import { fingerprintPrivateFile, readSource } from './files.js';
import { invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { prepareNativeProjection } from './native-git.js';
import { nativeGitSnapshots } from './native-pr.js';
import { fullGitBundle } from './work-git-bundle.js';
import { workGit } from './work-git.js';
import { startNativeContribution, registerNativeContribution } from './native-contribution-register.js';
import type { WorkStore } from './work-store.js';
import { forgeTempDir } from './forge-disk.js';

const gitId = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  sha = z.string().regex(/^[0-9a-f]{64}$/);
export const nativeGitContributionCommandSchema = z
  .object({
    action: z.literal('import-native-git-contribution'),
    operationId: z.uuid(),
    intentId: z.uuid(),
    expectedBase: sha,
    expectedHead: gitId,
    path: z.string().min(1),
    ref: z.string().min(1).default('refs/heads/contribution'),
    sha256: sha,
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export type NativeGitContributionCommand = z.infer<typeof nativeGitContributionCommandSchema>;
export const nativeGitContributionRequest = (c: NativeGitContributionCommand) =>
  digest(
    JSON.stringify({
      action: c.action,
      intentId: c.intentId,
      expectedBase: c.expectedBase,
      expectedHead: c.expectedHead,
      ref: c.ref,
      sha256: c.sha256,
      name: c.name,
    }),
  );
export const contributionRef = (operationId: string) => `refs/forge/contributions/${operationId}/head`;

export async function importNativeGitContribution(
  store: WorkStore,
  input: unknown,
  revision: number,
  observed: { wireRef?: 'refs/heads/contribution' } = {},
) {
  const parsed = nativeGitContributionCommandSchema.safeParse(input);
  invariant(
    parsed.success && Number.isSafeInteger(revision) && revision >= 0,
    'BAD_ARGUMENT',
    'Select original native base, Git candidate and full bundle digest.',
  );
  invariant(store.native, 'UNSUPPORTED_NATIVE_WORK', 'Select a native Work owner.');
  const command = parsed.data,
    initial = startNativeContribution(
      store,
      {
        id: command.operationId,
        request: nativeGitContributionRequest(command),
        intentId: command.intentId,
        base: command.expectedBase,
        provenance: 'unverified-git-bundle',
      },
      revision,
    );
  if (initial.original) return initial.original;
  invariant(isAbsolute(command.path), 'BAD_ARGUMENT', 'Choose an absolute local full Git bundle path.');
  const file = await fingerprintPrivateFile(command.path, 'INVALID_CONTRIBUTION');
  invariant(
    file.sha256 === command.sha256,
    'INVALID_CONTRIBUTION',
    'Original Git bundle differs from its selected digest.',
  );
  const bytes = readSource(
    realpathSync(dirname(command.path)),
    basename(command.path),
    file.size + 1,
    command.sha256,
  );
  invariant(
    bytes && bytes.length === file.size,
    'INVALID_CONTRIBUTION',
    'Original Git bundle changed during selection.',
  );
  const projected = await prepareNativeProjection(store, command.expectedBase);
  const scratch = forgeTempDir('native-git-contribution');
  try {
    const repo = join(scratch, 'input.git');
    workGit(scratch, [
      'init',
      '--bare',
      '--template=',
      `--object-format=${projected.projection.format}`,
      repo,
    ]);
    const inputPath = join(scratch, 'original.bundle');
    writeFileSync(inputPath, bytes, { flag: 'wx', mode: 0o600 });
    // Verify against an empty repository: input is self-contained, not dependent on owner alternates.
    workGit(repo, ['bundle', 'verify', inputPath]);
    const refs = workGit(repo, ['bundle', 'unbundle', inputPath]).trim().split('\n');
    invariant(
      refs.includes(`${command.expectedHead} ${command.ref}`),
      'CONTRIBUTION_CHANGED',
      'The full bundle differs from the selected Git ref and commit.',
    );
    invariant(
      workGit(repo, ['rev-parse', '--verify', `${command.expectedHead}^{commit}`]).trim() ===
        command.expectedHead,
      'CONTRIBUTION_CHANGED',
      'Select an original Git commit, not a tag object.',
    );
    let base: string;
    try {
      base = workGit(repo, ['merge-base', projected.projection.head, command.expectedHead]).trim();
    } catch {
      invariant(
        false,
        'CONTRIBUTION_CHANGED',
        'The candidate must descend from this exact projected native base.',
      );
    }
    invariant(
      base === projected.projection.head,
      'CONTRIBUTION_CHANGED',
      'The candidate must descend from this exact projected native base.',
    );
    workGit(repo, ['--no-lazy-fetch', 'fsck', '--connectivity-only', '--no-reflogs']);
    // Transport ref names are claims. Each durable source bundle has its own operation pin,
    // preventing two accepted returns from overwriting one retained contribution ref.
    writeFileSync(join(repo, 'objects/info/alternates'), '');
    const retainedRef = contributionRef(command.operationId),
      retainedPath = join(scratch, 'candidate.bundle'),
      retained = await fullGitBundle(
        repo,
        [{ ref: retainedRef, head: command.expectedHead }],
        retainedPath,
        'INVALID_CONTRIBUTION',
      );
    const bundle = readFileSync(retainedPath),
      stagePath = join(scratch, 'native');
    mkdirSync(stagePath, { mode: 0o700 });
    const stage = new NativeSource(stagePath),
      original = new NativeSource(store.root),
      ids = new Set<string>();
    // The existing native base closure remains source authority; no contributor Work is imported.
    for (const id of original.ancestors(command.expectedBase)) {
      stage.put(original.object(id));
      ids.add(id);
      const state = original.state(id);
      for (const f of state.files) {
        stage.put(original.object(f.blob));
        ids.add(f.blob);
      }
      if (state.git) {
        stage.put(original.object(state.git.bundle));
        ids.add(state.git.bundle);
      }
    }
    for (const b of [bytes, projected.bundle, projected.mapping]) ids.add(stage.put(b));
    const mapping = JSON.parse(projected.mapping.toString('utf8')) as {
      states: { state: string; commit: string }[];
    };
    const known = new Map(mapping.states.map(item => [item.commit, item.state]));
    known.set(projected.projection.head, command.expectedBase);
    const at = workGit(repo, ['show', '-s', '--format=%cI', command.expectedHead]).trim();
    const snapshot = nativeGitSnapshots(
      store,
      repo,
      { head: command.expectedHead, base: projected.projection.head, at },
      bundle,
      projected.projection,
      known,
      stage,
      { baseState: command.expectedBase, label: 'Imported Git contribution snapshot' },
    );
    invariant(
      stage.contains(snapshot.native.head, command.expectedBase),
      'CONTRIBUTION_CHANGED',
      'Candidate native ancestry differs from its original base.',
    );
    for (const id of snapshot.objects) ids.add(id);
    const receipt = {
      id: command.operationId,
      request: nativeGitContributionRequest(command),
      intentId: command.intentId,
      base: command.expectedBase,
      head: snapshot.native.head,
      at: new Date().toISOString(),
      provenance: 'unverified-git-bundle' as const,
      size: file.size,
      inputSha256: command.sha256,
      bundleSha256: retained.sha256,
      ...(observed.wireRef ? { wireRef: observed.wireRef } : {}),
      selectedRef: command.ref,
      retainedRef,
      gitBase: projected.projection.head,
      gitHead: command.expectedHead,
      projection: projected.projection,
    };
    return registerNativeContribution(store, initial.current!, revision, receipt, command.name, stage, ids);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
