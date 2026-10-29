// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { HostedArtifact, GithubRepository } from '../src/github';
import { blobStore } from './blobStore';
import { derivedArtifact, derivedBytes } from './derivedArtifactActions';
import { decodeHostedArtifact } from '../src/hosted-artifact';
import { hostedQuery, hostedIndexQuery } from '../src/hosted-query';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { exchangeRequest } from '../src/exchange-request';
type Index = Omit<HostedArtifact, 'content'> & {
  contentRef: string;
  contentSize: number;
  ranges: Record<string, { offset: number; size: number; digest: string }>;
};
/** One immutable graph/document index plus concatenated UTF-8 source. Both use
 * the existing derived-artifact registry, so export and cleanup see every byte.
 * The original gzip is decoded only on a cold index build, never per endpoint. */
export async function indexedHostedQuery(
  ctx: ActionCtx,
  original: string,
  endpoint: string,
  currentHead: string,
  repository: GithubRepository,
  checkAccess: () => Promise<unknown>,
) {
  const record = await derivedArtifact(
    ctx,
    original,
    'hosted-query-index-v1',
    '',
    async () => {
      const blob = await blobStore(ctx).get(original);
      invariant(blob, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
      const artifact = await decodeHostedArtifact(blob);
      // Preserve the complete graph and source-manifest integrity checks before
      // publishing any index; status permits an upstream head to have moved.
      hostedQuery(artifact, 'status', artifact.pack.source.gitHead!, artifact.repository);
      let offset = 0;
      const ranges: Index['ranges'] = {},
        parts: Buffer[] = [];
      for (const [path, text] of Object.entries(artifact.content)) {
        const bytes = Buffer.from(text);
        ranges[path] = { offset, size: bytes.length, digest: digest(bytes) };
        parts.push(bytes);
        offset += bytes.length;
      }
      const source = await derivedArtifact(
        ctx,
        original,
        'hosted-query-content-v1',
        '',
        async () =>
          new Blob(
            parts.map(part => new Uint8Array(part)),
            { type: 'application/octet-stream' },
          ),
        checkAccess,
      );
      invariant(source?.storageId, 'INVALID_ARTIFACT', 'Stored source index is unavailable.');
      const { content: _content, ...metadata } = artifact;
      void _content;
      const value = JSON.stringify({
        ...metadata,
        ranges,
        contentRef: source.storageId,
        contentSize: offset,
      } satisfies Index);
      return Buffer.byteLength(value) <= 64_000 ? value : new Blob([value], { type: 'application/json' });
    },
    checkAccess,
  );
  invariant(record, 'INVALID_ARTIFACT', 'Stored source index is unavailable.');
  const index = JSON.parse(Buffer.from(await derivedBytes(ctx, record)).toString('utf8')) as Index;
  const content: Record<string, string> = {};
  if (endpoint.split('?')[0] === 'source') {
    const file = new URLSearchParams(endpoint.split('?')[1]).get('file') ?? '',
      pin = Object.hasOwn(index.ranges, file) ? index.ranges[file] : undefined;
    if (pin) {
      const url = await blobStore(ctx).getUrl(index.contentRef);
      invariant(url, 'INVALID_ARTIFACT', 'Stored source index is unavailable.');
      await checkAccess();
      const bytes =
        pin.size === 0
          ? Buffer.alloc(0)
          : await exchangeRequest(
              'indexed source range',
              url,
              {
                headers: {
                  Range: `bytes=${pin.offset}-${pin.offset + pin.size - 1}`,
                  'accept-encoding': 'identity',
                },
              },
              async (response, progressed) => {
                const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
                invariant(
                  response.status === 206 &&
                    response.body &&
                    range &&
                    Number(range[1]) === pin.offset &&
                    Number(range[2]) === pin.offset + pin.size - 1 &&
                    Number(range[3]) === index.contentSize,
                  'INVALID_ARTIFACT',
                  'Stored source range differs.',
                );
                const reader = response.body.getReader(),
                  chunks: Buffer[] = [];
                let size = 0;
                try {
                  for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    progressed();
                    size += next.value.length;
                    invariant(size <= pin.size, 'INVALID_ARTIFACT', 'Stored source exceeds its exact size.');
                    chunks.push(Buffer.from(next.value));
                  }
                } finally {
                  await reader.cancel().catch(() => undefined);
                }
                return Buffer.concat(chunks);
              },
            );
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.digest,
        'ARTIFACT_INTEGRITY',
        'Stored source differs from its index.',
      );
      content[file] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
  }
  await checkAccess();
  return hostedIndexQuery({ ...index, content }, endpoint, currentHead, repository);
}
