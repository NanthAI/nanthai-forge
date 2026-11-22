// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { text } from 'node:stream/consumers';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const blob = row => digest(String(row));
export const pathOf = row => {
  const prefix = 'dir/' + String(row).padStart(8, '0') + '/';
  const detail = row % 211 === 0 ? '文' : 'abc';
  return prefix + detail + 'x'.repeat((row % 20 < 13 ? 78 : 77) - prefix.length - 3);
};
export const byteCount = files => Math.round((files * 3_670_345_292) / 487_756);
export const fileSize = (files, row) => {
  const total = byteCount(files);
  return Math.floor(total / files) + Number(row < total % files);
};

const encodeWindow = objects =>
  JSON.stringify({
    digests: objects.map(entry => entry.digest).join(''),
    sizes: objects.map(entry => entry.size),
    packs: objects.flatMap((entry, index) => (entry.pack ? [{ index, ...entry.pack }] : [])),
    recipes: objects.flatMap((entry, index) => (entry.recipe ? [{ index, ...entry.recipe }] : [])),
    stateGenerations: objects.flatMap((entry, index) =>
      entry.stateGeneration ? [{ index, generation: entry.stateGeneration }] : [],
    ),
    stateSizes: objects.flatMap((entry, index) => (entry.stateSize ? [{ index, ...entry.stateSize }] : [])),
  });

function sourceWindow(files, start) {
  const end = Math.min(start + 1000, files);
  const digest = blob(files + start);
  const size = Math.max(fileSize(files, start), fileSize(files, end - 1)) * (end - start);
  let offset = 0;
  const objects = [];
  for (let row = start; row < end; row++) {
    const length = fileSize(files, row);
    objects.push({ digest: blob(row), size: length, pack: { digest, size, offset } });
    offset += length;
  }
  objects.push({ digest, size });
  return { key: String(end), value: encodeWindow(objects) };
}

export async function servePublication(files, directory) {
  const input = JSON.parse(readFileSync(join(directory, 'inputs.json')));
  const recorded = [];
  let projected = 0;
  let state;
  let root;
  let mode;
  let r2Reads;
  let queryCalls;
  let mutationCalls;
  let ready;
  function rpc(name, args) {
    switch (name) {
      case 'projectGithubImportCatalog:stored': {
        queryCalls++;
        const after = Number(args.after);
        const windows = [];
        for (let start = after; start < files && windows.length < 2; start += 1000)
          windows.push(sourceWindow(files, start));
        return windows.length
          ? windows
          : recorded.slice(Math.max(0, after - files), Math.max(0, after - files) + 2);
      }
      case 'projectGithubImportStore:archiveProgress':
        if (args.state) state = args.state;
        recorded.push({ key: String(files + recorded.length + 1), value: encodeWindow(args.objects) });
        break;
      case 'projectGithubImportPublication:begin':
        assert.equal(args.state.sha256, input.expectedState);
        root ??= args.root;
        assert.deepEqual(args.root, root, 'publication retry preserves the manifest pin');
        break;
      case 'projectGithubImportPublication:stage':
        for (const entry of args.entries) {
          if (entry.collection !== 'sourceTreePaths') continue;
          assert.equal(entry.position, projected);
          for (const path of JSON.parse(entry.value).paths) assert.equal(path, pathOf(projected++));
        }
        break;
      case 'projectGithubImportPublication:finish':
        assert.equal(projected, files);
        ready = true;
        break;
      default:
        assert.equal(name, 'projectGithubImportCatalog:publish');
    }
    mutationCalls++;
    return null;
  }

  const send = (response, value) => response.end(JSON.stringify(value));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/job') {
        mode = url.searchParams.get('mode');
        projected = queryCalls = mutationCalls = 0;
        ready = false;
        r2Reads = 0;
        return send(response, { ...input, state });
      }
      if (url.pathname === '/result') {
        assert.equal(ready, true);
        if (mode !== 'retry-state') assert.equal(r2Reads, input.pages + 2);
        return send(response, { state, queryCalls, mutationCalls, r2Reads, ready });
      }
      if (url.pathname === '/rpc') {
        const { name, args } = JSON.parse(await text(request));
        return send(response, rpc(name, args));
      }
      if (url.pathname.startsWith('/github/')) {
        assert.equal(
          url.pathname,
          '/github/repos/fixture/large',
          'complete pins need no GitHub source request',
        );
        return send(response, {
          full_name: 'fixture/large',
          private: false,
          default_branch: 'main',
          html_url: 'https://github.com/fixture/large',
        });
      }
      if (url.searchParams.has('list-type'))
        return response.end('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
      const key = url.pathname.split('/').at(-1);
      assert.match(key, /^[0-9a-f]{64}$/);
      const file = join(directory, key);
      if (request.method === 'PUT') {
        const hash = createHash('sha256');
        await pipeline(
          request,
          new Transform({
            transform(bytes, _, callback) {
              hash.update(bytes);
              callback(null, bytes);
            },
          }),
          createWriteStream(file),
        );
        assert.equal(hash.digest('base64'), request.headers['x-amz-checksum-sha256']);
        response.end();
        return;
      }
      r2Reads++;
      const size = statSync(file).size;
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range ? Number(range[2]) : size - 1;
      response.setHeader('Content-Length', end - start + 1);
      if (range) {
        response.statusCode = 206;
        response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      await pipeline(createReadStream(file, { start, end }), response);
    } catch (error) {
      console.error(error);
      response.statusCode = 560;
      response.end('Publication fixture failed');
    }
  });
  // A digest sort can keep the client idle between two requests.
  server.keepAliveTimeout = 120_000;
  // No port is published by the container. Its peer shares only the network namespace.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log(`http://127.0.0.1:${server.address().port}`);
}
