// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { WorkStore } from './work-store.js';
import { NativeSource } from './native-source.js';
import { prepareNativeProjection } from './native-git.js';
import {
  nativeGitContributionRequest,
  importNativeGitContribution,
  contributionRef,
  type NativeGitContributionCommand,
} from './native-git-contribution.js';
import { workGit } from './work-git.js';
import { fullGitBundle } from './work-git-bundle.js';
import { streamGit } from './work-git-stream.js';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { forgeTempDir } from './forge-disk.js';

export const nativeGitReceiveScopeSchema = z
  .object({
    root: z.string().min(1),
    transport: z.string().min(1),
    operationId: z.uuid(),
    intentId: z.uuid(),
    expectedBase: z.string().regex(/^[0-9a-f]{64}$/),
    gitBase: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    format: z.enum(['sha1', 'sha256']),
  })
  .strict();
type Scope = z.infer<typeof nativeGitReceiveScopeSchema>;
const wireRef = 'refs/heads/contribution';
const inputPath = (store: WorkStore, scope: Scope) =>
  join(store.directory, `native-git-return-${scope.operationId}.bundle`);
function command(store: WorkStore, scope: Scope, head: string, sha256: string): NativeGitContributionCommand {
  return {
    action: 'import-native-git-contribution',
    operationId: scope.operationId,
    intentId: scope.intentId,
    expectedBase: scope.expectedBase,
    expectedHead: head,
    path: inputPath(store, scope),
    ref: contributionRef(scope.operationId),
    sha256,
    name: `Git contribution ${scope.operationId.slice(0, 8)}`,
  };
}
function original(store: WorkStore, scope: Scope) {
  const data = store.load();
  invariant(
    store.native && data.intents.find(i => i.id === scope.intentId)?.base === scope.expectedBase,
    'CONTRIBUTION_CHANGED',
    'Select the existing native Intent and its exact original base.',
  );
  const receipt = data.nativeContributionReceipts?.find(r => r.id === scope.operationId),
    lane = data.lanes.find(l => l.id === scope.operationId);
  if (!receipt && !lane) return;
  invariant(
    receipt?.provenance === 'unverified-git-bundle' &&
      lane?.nativeContributionId === receipt.id &&
      lane.intentId === scope.intentId &&
      receipt.base === scope.expectedBase &&
      receipt.gitBase === scope.gitBase &&
      receipt.projection.format === scope.format &&
      receipt.request ===
        nativeGitContributionRequest(command(store, scope, receipt.gitHead, receipt.inputSha256)),
    'WORK_OPERATION_CHANGED',
    'This contribution URL belongs to another original request.',
  );
  return { receipt, lane };
}
export async function receiveNativeGitContribution(scope: Scope, update: string) {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) refs\/heads\/contribution\n$/.exec(
    update,
  );
  const size = scope.format === 'sha1' ? 40 : 64;
  invariant(
    match && match[1]!.length === size && match[2]!.length === size && !/^0+$/.test(match[2]!),
    'CONTRIBUTION_CHANGED',
    'Push one original commit to refs/heads/contribution for this operation.',
  );
  const store = new WorkStore(scope.root),
    head = match[2]!,
    previous = original(store, scope);
  invariant(
    match[1] ===
      (previous?.lane.state !== 'creating' && previous ? previous.receipt.gitHead : '0'.repeat(size)),
    'CONTRIBUTION_CHANGED',
    'The originally advertised contribution changed. Reconcile this URL.',
  );
  if (previous) {
    invariant(
      previous.receipt.gitHead === head,
      'WORK_OPERATION_CHANGED',
      'This operation already retains another original commit.',
    );
    const result = await importNativeGitContribution(
      store,
      command(store, scope, head, previous.receipt.inputSha256),
      store.load().revision,
      { wireRef },
    );
    rmSync(inputPath(store, scope), { force: true });
    return result;
  }
  const retained = inputPath(store, scope);
  if (!existsSync(retained)) {
    const scratch = mkdtempSync(join(store.directory, 'native-git-receive-'));
    chmodSync(scratch, 0o700);
    try {
      const objects = realpathSync(join(scope.transport, 'objects'));
      const quarantine = process.env.GIT_OBJECT_DIRECTORY
        ? realpathSync(process.env.GIT_OBJECT_DIRECTORY)
        : undefined;
      invariant(
        !quarantine || quarantine.startsWith(objects + '/'),
        'INVALID_CONTRIBUTION',
        'Incoming Git objects are outside this transport.',
      );
      workGit(scratch, ['init', '--bare', '--template=', `--object-format=${scope.format}`]);
      writeFileSync(
        join(scratch, 'objects/info/alternates'),
        [objects, ...(quarantine ? [quarantine] : [])].map(p => JSON.stringify(p)).join('\n') + '\n',
        { mode: 0o600 },
      );
      const bundlePath = join(scratch, 'source.bundle');
      await fullGitBundle(
        scratch,
        [{ ref: contributionRef(scope.operationId), head }],
        bundlePath,
        'INVALID_CONTRIBUTION',
      );
      try {
        linkSync(bundlePath, retained);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  invariant(
    workGit(scope.transport, ['bundle', 'list-heads', retained]).trim() ===
      `${head} ${contributionRef(scope.operationId)}`,
    'WORK_OPERATION_CHANGED',
    'This operation already retained different original Git source.',
  );
  const file = await fingerprintPrivateFile(retained, 'INVALID_CONTRIBUTION');
  const result = await importNativeGitContribution(
    store,
    command(store, scope, head, file.sha256),
    store.load().revision,
    { wireRef },
  );
  rmSync(retained, { force: true });
  return result;
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function nativeGitContributionHttp(
  root: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
) {
  invariant(
    process.platform !== 'win32',
    'UNSUPPORTED',
    'Git contribution hooks currently support macOS and Linux. Full native Git bundle import remains available.',
  );
  const route =
    /^\/api\/git\/contribute\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      url.pathname,
    );
  invariant(route, 'NOT_FOUND', 'Use the original native Intent/base/operation Git contribution URL.');
  const endpoint = route[4]!,
    advertisement = endpoint === 'info/refs';
  invariant(
    advertisement
      ? request.method === 'GET' &&
          ['?service=git-upload-pack', '?service=git-receive-pack'].includes(url.search)
      : request.method === 'POST' &&
          !url.search &&
          request.headers['content-type'] === `application/x-${endpoint}-request`,
    'BAD_METHOD',
    'Use the original Git clone/fetch/push service.',
  );
  const store = new WorkStore(root),
    base = route[3]!;
  invariant(
    store.load().intents.find(i => i.id === route[1])?.base === base,
    'CONTRIBUTION_CHANGED',
    'Select the original native Intent base.',
  );
  const projected = await prepareNativeProjection(store, base),
    directory = forgeTempDir('native-git-http');
  chmodSync(directory, 0o700);
  try {
    const scope = nativeGitReceiveScopeSchema.parse({
      root,
      intentId: route[1],
      operationId: route[2],
      expectedBase: base,
      gitBase: projected.projection.head,
      format: projected.projection.format,
      transport: join(directory, 'source.git'),
    });
    const previous = original(store, scope),
      temporary = join(directory, 'base.git');
    workGit(directory, ['init', '--bare', '--template=', `--object-format=${scope.format}`, temporary]);
    for (const [name, bytes] of [
      ['base', projected.bundle],
      ...(previous
        ? [['candidate', new NativeSource(store.root).object(previous.receipt.bundleSha256)]]
        : []),
    ] as [string, Buffer][]) {
      const path = join(directory, name + '.bundle');
      writeFileSync(path, bytes, { mode: 0o600 });
      workGit(temporary, ['bundle', 'verify', path]);
      workGit(temporary, ['bundle', 'unbundle', path]);
    }
    writeFileSync(join(temporary, 'objects/info/alternates'), '');
    const active = previous && previous.lane.state !== 'creating';
    const refs = [
      { ref: 'refs/heads/base', head: scope.gitBase },
      ...(active ? [{ ref: wireRef, head: previous.receipt.gitHead }] : []),
    ];
    const bundlePath = join(directory, 'selected.bundle');
    await fullGitBundle(temporary, refs, bundlePath, 'INVALID_CONTRIBUTION');
    workGit(directory, [
      'clone',
      '--bare',
      '--no-hardlinks',
      '--template=',
      '--branch',
      active ? 'contribution' : 'base',
      '--',
      bundlePath,
      scope.transport,
    ]);
    const hooks = join(directory, 'hooks');
    mkdirSync(hooks, { mode: 0o700 });
    const script =
      '#!/bin/sh\nexec ' +
      quote(process.execPath) +
      ' ' +
      quote(fileURLToPath(new URL('./native-git-receive-hook.js', import.meta.url))) +
      ' ' +
      quote(Buffer.from(JSON.stringify(scope)).toString('base64')) +
      '\n';
    writeFileSync(join(hooks, 'pre-receive'), script, { mode: 0o700, flag: 'wx' });
    await streamGit(directory, endpoint, url, request, response, hooks);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
