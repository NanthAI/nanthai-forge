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
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { contributionCommandSchema, type ContributionCommand } from './work-types.js';
import { WorkStore } from './work-store.js';
import { workGit } from './work-git.js';
import { withGithubTransport } from './work-github.js';
import { fullGitBundle } from './work-git-bundle.js';
import { streamGit } from './work-git-stream.js';
import { importBundle } from './work-contribution.js';
import { fingerprintPrivateFile } from './files.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { nativeGitContributionHttp } from './native-git-receive.js';

export const nativeContributionScope = contributionCommandSchema
  .pick({ operationId: true, intentId: true, expectedBase: true })
  .extend({ root: z.string().min(1), transport: z.string().min(1) });
type Scope = z.infer<typeof nativeContributionScope>;
const ref = 'refs/heads/contribution';
const inputPath = (store: WorkStore, scope: Scope) =>
  join(store.directory, `native-contribution-${scope.operationId}.bundle`);
function command(store: WorkStore, scope: Scope, head: string, sha256: string): ContributionCommand {
  return {
    action: 'import-bundle',
    operationId: scope.operationId,
    intentId: scope.intentId,
    expectedBase: scope.expectedBase,
    expectedHead: head,
    path: inputPath(store, scope),
    ref,
    sha256,
    name: `Git contribution ${scope.operationId.slice(0, 8)}`,
  };
}
function originalLane(store: WorkStore, scope: Scope) {
  const data = store.load(),
    intent = data.intents.find(item => item.id === scope.intentId);
  invariant(
    intent?.base === scope.expectedBase,
    'CONTRIBUTION_CHANGED',
    'Select the original Intent and base for this Git contribution.',
  );
  const lane = data.lanes.find(item => item.id === scope.operationId),
    source = lane?.contribution;
  if (lane)
    invariant(
      source &&
        lane.intentId === scope.intentId &&
        source.base === scope.expectedBase &&
        source.ref === ref &&
        source.request === digest(JSON.stringify(command(store, scope, source.head, source.sha256))),
      'WORK_OPERATION_CHANGED',
      'This contribution URL belongs to another original request. Existing work is preserved.',
    );
  return lane;
}
export async function receiveContribution(scope: Scope, update: string) {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) refs\/heads\/contribution\n$/.exec(
    update,
  );
  invariant(
    match &&
      match[1]!.length === scope.expectedBase.length &&
      match[2]!.length === scope.expectedBase.length &&
      !/^0+$/.test(match[2]!),
    'CONTRIBUTION_CHANGED',
    'Push one original commit to refs/heads/contribution for this operation.',
  );
  const store = new WorkStore(scope.root),
    head = match[2]!,
    lane = originalLane(store, scope);
  invariant(
    match[1] === (lane && lane.state !== 'creating' ? lane.contribution!.head : '0'.repeat(head.length)),
    'CONTRIBUTION_CHANGED',
    'The originally advertised contribution changed. Reconcile this URL.',
  );
  if (lane) {
    invariant(
      lane.contribution!.head === head,
      'WORK_OPERATION_CHANGED',
      'This original contribution already names another commit. Use a new operation for another contribution.',
    );
    return importBundle(store, command(store, scope, head, lane.contribution!.sha256), store.load().revision);
  }
  const retained = inputPath(store, scope);
  if (!existsSync(retained)) {
    const scratch = mkdtempSync(join(store.directory, 'receive-'));
    chmodSync(scratch, 0o700);
    try {
      const objects = realpathSync(join(scope.transport, 'objects'));
      const quarantine = process.env.GIT_OBJECT_DIRECTORY
        ? realpathSync(process.env.GIT_OBJECT_DIRECTORY)
        : undefined;
      invariant(
        !quarantine || quarantine.startsWith(objects + '/'),
        'INVALID_CONTRIBUTION',
        'Native incoming objects are outside this transport.',
      );
      workGit(scratch, [
        'init',
        '--bare',
        '--template=',
        `--object-format=${head.length === 64 ? 'sha256' : 'sha1'}`,
      ]);
      writeFileSync(
        join(scratch, 'objects/info/alternates'),
        [objects, ...(quarantine ? [quarantine] : [])].map(path => JSON.stringify(path)).join('\n') + '\n',
        { mode: 0o600 },
      );
      const bundle = join(scratch, 'source.bundle');
      await fullGitBundle(scratch, [{ ref, head }], bundle, 'INVALID_CONTRIBUTION');
      try {
        linkSync(bundle, retained);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  invariant(
    workGit(scope.transport, ['bundle', 'list-heads', retained]).trim() === `${head} ${ref}`,
    'WORK_OPERATION_CHANGED',
    'This operation retained different original source. Its bundle and work remain available.',
  );
  const file = await fingerprintPrivateFile(retained, 'INVALID_CONTRIBUTION');
  return importBundle(store, command(store, scope, head, file.sha256), store.load().revision);
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function gitContributionHttp(
  root: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (new WorkStore(root).native) return nativeGitContributionHttp(root, url, request, response);
  invariant(
    process.platform !== 'win32',
    'UNSUPPORTED',
    'Native contribution hooks currently support macOS and Linux. Full bundle import remains available.',
  );
  const route =
    /^\/api\/git\/contribute\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{40}|[0-9a-f]{64})\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      url.pathname,
    );
  invariant(route, 'NOT_FOUND', 'Use the original Intent/base/operation contribution Git URL.');
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
    'Use the native clone/fetch/push service for this original contribution.',
  );
  const directory = mkdtempSync(join(tmpdir(), 'forge-git-http-'));
  chmodSync(directory, 0o700);
  try {
    const scope = nativeContributionScope.parse({
      root,
      intentId: route[1],
      operationId: route[2],
      expectedBase: route[3],
      transport: join(directory, 'source.git'),
    });
    const store = new WorkStore(root),
      lane = originalLane(store, scope),
      bundle = join(directory, 'source.bundle');
    await withGithubTransport(store, async transport => {
      const refs = [
        { ref: 'refs/heads/base', head: scope.expectedBase },
        ...(lane?.contribution && lane.state !== 'creating' ? [{ ref, head: lane.contribution.head }] : []),
      ];
      await fullGitBundle(transport, refs, bundle, 'INVALID_CONTRIBUTION');
    });
    workGit(directory, [
      'clone',
      '--bare',
      '--no-hardlinks',
      '--template=',
      '--branch',
      lane && lane.state !== 'creating' ? 'contribution' : 'base',
      '--',
      bundle,
      scope.transport,
    ]);
    const hooks = join(directory, 'hooks');
    mkdirSync(hooks, { mode: 0o700 });
    const script =
      '#!/bin/sh\nexec ' +
      quote(process.execPath) +
      ' ' +
      quote(fileURLToPath(new URL('./work-git-receive-hook.js', import.meta.url))) +
      ' ' +
      quote(Buffer.from(JSON.stringify(scope)).toString('base64')) +
      '\n';
    writeFileSync(join(hooks, 'pre-receive'), script, { mode: 0o700, flag: 'wx' });
    await streamGit(directory, endpoint, url, request, response, hooks);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
