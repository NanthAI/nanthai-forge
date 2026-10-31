// SPDX-License-Identifier: Apache-2.0
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamGit } from './work-git-stream.js';
import { gitContributionHttp } from './work-git-receive.js';
import { WorkStore } from './work-store.js';
import { nativeChannels } from './native-work.js';
import { nativeChannelGit } from './native-git-http.js';
import { channelStatus, exportChannelBundle } from './work-channel.js';
import { channelCommandSchema } from './work-types.js';
import { workGit } from './work-git.js';
import { ForgeError, invariant } from './errors.js';
import { forgeTempDir } from './forge-disk.js';

export async function gitHttp(root: string, url: URL, request: IncomingMessage, response: ServerResponse) {
  if (url.pathname.startsWith('/api/git/contribute/'))
    return gitContributionHttp(root, url, request, response);
  const route = /^\/api\/git\/([0-9a-f-]{36})\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
  const alias = /^\/api\/git\/channel\/([^/]+)\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
  invariant(route || alias, 'NOT_FOUND', 'Select an accepted source or current Channel Git endpoint.');
  const endpoint = (route ?? alias)![2],
    advertisement = endpoint === 'info/refs';
  invariant(
    advertisement
      ? request.method === 'GET' && url.search === '?service=git-upload-pack'
      : request.method === 'POST' &&
          !url.search &&
          request.headers['content-type'] === 'application/x-git-upload-pack-request',
    'BAD_METHOD',
    'This endpoint serves native clone/fetch of original accepted source.',
  );
  const store = new WorkStore(root);
  const data = store.load();
  let id = route?.[1];
  if (alias) {
    let name: string;
    try {
      name = decodeURIComponent(alias[1]!);
    } catch {
      throw new ForgeError('BAD_ARGUMENT', 'Send an encoded Channel name.');
    }
    const current = (store.native ? nativeChannels(data) : channelStatus(store, data)).find(
      item => item.name === name,
    );
    invariant(
      current?.head && current.moveId && !current.diagnostic,
      'NOT_FOUND',
      'This Channel has no current verified acceptance. Original immutable URLs remain available.',
    );
    id = current.moveId;
  }
  const command = channelCommandSchema.safeParse({ action: 'export-channel', id });
  invariant(
    command.success && command.data.action === 'export-channel',
    'BAD_ARGUMENT',
    'Use an original acceptance UUID.',
  );
  const directory = forgeTempDir('git-http');
  chmodSync(directory, 0o700);
  let bundle: string | undefined;
  try {
    if (store.native)
      bundle = await nativeChannelGit(store, data, command.data.id, Boolean(alias), directory);
    else {
      const exported = await exportChannelBundle(store, command.data.id, Boolean(alias));
      bundle = exported.result.path;
    }
    // ponytail: derive each request from the existing verified bundle; cache only after measuring real clone pressure.
    workGit(directory, [
      'clone',
      '--bare',
      '--no-hardlinks',
      '--template=',
      '--branch',
      'accepted',
      '--',
      bundle,
      join(directory, 'source.git'),
    ]);
    await streamGit(directory, endpoint!, url, request, response);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (bundle) rmSync(bundle, { force: true });
  }
}
