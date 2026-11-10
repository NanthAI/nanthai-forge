// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { networkFetch, networkTimeout } from './network-fetch.js';
import { assertGithubRateLimit, type GithubFetch } from './github.js';
import { ForgeError, invariant } from './errors.js';
import { attributeLines, attributePatternMatches } from './git-attributes.js';

/** Git LFS spec: a pointer file is under 1024 bytes. */
export const lfsPointerMaxBytes = 1024;
/** A mirror uploads an LFS object GitHub lacks from one in-memory read, the same
 * bound as the Git blob endpoint the mirror already uses for ordinary files. */
export const lfsMirrorUploadBytes = 100 * 1024 * 1024;
/** Objects per LFS batch request (the reference client's batch size). */
export const lfsBatchObjects = 100;

export type LfsPointer = { oid: string; size: number };
const versions = new Set(['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1']);

/** Strict pointer parse: `version` first, sorted `key value` lines, a sha256 oid
 * and a decimal size, newline-terminated. Anything else is ordinary file bytes. */
export function parseLfsPointer(bytes: Uint8Array): LfsPointer | null {
  if (bytes.length >= lfsPointerMaxBytes || bytes.length < 40) return null;
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.startsWith('version ') || !text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  const values = new Map<string, string>();
  let previous = '';
  for (const [index, line] of lines.entries()) {
    const match = /^([a-z0-9.-]+) (\S.*)$/.exec(line);
    if (!match) return null;
    const [, key, value] = match;
    if (index > 0 && (key! <= previous || key === 'version')) return null;
    previous = index === 0 ? '' : key!;
    values.set(key!, value!);
  }
  const oid = /^sha256:([0-9a-f]{64})$/.exec(values.get('oid') ?? '')?.[1];
  const size = values.get('size') ?? '';
  if (!versions.has(values.get('version')!) || !oid || !/^(0|[1-9][0-9]{0,15})$/.test(size)) return null;
  const parsed = Number(size);
  return Number.isSafeInteger(parsed) ? { oid, size: parsed } : null;
}

export const formatLfsPointer = (pointer: LfsPointer) =>
  Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`,
  );

/** One `.gitattributes` line that sets or clears `filter` for a pattern. */
export type LfsRule = { base: string; pattern: string; lfs: boolean };

export { isGitattributesPath } from './git-attributes.js';

/** Rules from every `.gitattributes`, shallow files first and lines in order, so
 * the last matching rule wins as in Git (deeper files override shallower ones).
 * Macro definitions are ignored; directory-only patterns never match files. */
export function lfsRules(files: { path: string; text: string }[]): LfsRule[] {
  const rules: LfsRule[] = [];
  for (const { base, pattern, attributes } of attributeLines(files)) {
    if (pattern.startsWith('[attr]')) continue;
    let lfs: boolean | null = null;
    for (const attribute of attributes)
      if (attribute === 'filter=lfs') lfs = true;
      else if (/^(?:filter=.*|-filter|!filter)$/.test(attribute)) lfs = false;
    if (lfs !== null) rules.push({ base, pattern, lfs });
  }
  return rules;
}

export function isLfsPath(rules: LfsRule[], path: string): boolean {
  let lfs = false;
  for (const rule of rules) if (attributePatternMatches(rule.base, rule.pattern, path)) lfs = rule.lfs;
  return lfs;
}

export type LfsAction = { href: string; header: Record<string, string> };
export type LfsBatchObject = LfsPointer & {
  download?: LfsAction;
  upload?: LfsAction;
  verify?: LfsAction;
  error?: { code: number; message: string };
};

const lfsMedia = 'application/vnd.git-lfs+json';
const basic = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
const action = (value: unknown): LfsAction | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const { href, header } = value as { href?: unknown; header?: unknown };
  invariant(
    typeof href === 'string' && new URL(href).protocol === 'https:',
    'GITHUB_RESPONSE',
    'GitHub LFS returned a non-HTTPS transfer address.',
  );
  const headers: Record<string, string> = {};
  if (header && typeof header === 'object')
    for (const [name, text] of Object.entries(header)) if (typeof text === 'string') headers[name] = text;
  return { href, header: headers };
};

/** One Git LFS batch request (basic transfer). Public repositories are read
 * anonymously; a token is sent only to github.com, never to transfer hosts
 * unless GitHub names it in the action's own headers. */
export async function lfsBatch(
  repository: string,
  operation: 'download' | 'upload',
  objects: LfsPointer[],
  token?: string,
  request: GithubFetch = networkFetch,
): Promise<LfsBatchObject[]> {
  invariant(/^[\w.-]+\/[\w.-]+$/.test(repository), 'BAD_REPOSITORY', 'Select a GitHub repository.');
  invariant(objects.length <= lfsBatchObjects, 'BAD_ARGUMENT', 'LFS batches hold at most 100 objects.');
  if (!objects.length) return [];
  const response = await request(`https://github.com/${repository}.git/info/lfs/objects/batch`, {
    method: 'POST',
    redirect: 'error',
    signal: networkTimeout(60_000),
    headers: {
      Accept: lfsMedia,
      'Content-Type': lfsMedia,
      'User-Agent': 'NanthAi-Forge',
      ...(token ? { Authorization: basic(token) } : {}),
    },
    body: JSON.stringify({
      operation,
      transfers: ['basic'],
      objects: objects.map(({ oid, size }) => ({ oid, size })),
      hash_algo: 'sha256',
    }),
  });
  assertGithubRateLimit(response);
  if (!response.ok) {
    await response.body?.cancel();
    throw new ForgeError(
      response.status === 401 || response.status === 403 || response.status === 404
        ? 'GITHUB_LFS_ACCESS'
        : 'GITHUB_UNAVAILABLE',
      `GitHub LFS refused the ${operation} batch for ${repository} (HTTP ${response.status}).`,
    );
  }
  const reply = (await response.json()) as { objects?: unknown };
  invariant(Array.isArray(reply.objects), 'GITHUB_RESPONSE', 'GitHub LFS returned no objects.');
  const wanted = new Map(objects.map(object => [object.oid, object.size]));
  return (reply.objects as Record<string, unknown>[]).map(item => {
    const oid = item.oid,
      size = item.size;
    invariant(
      typeof oid === 'string' && wanted.get(oid) === size,
      'GITHUB_RESPONSE',
      'GitHub LFS answered for another object.',
    );
    const actions = (item.actions ?? {}) as Record<string, unknown>;
    const error = item.error as { code?: unknown; message?: unknown } | undefined;
    return {
      oid,
      size: size as number,
      ...(actions.download ? { download: action(actions.download)! } : {}),
      ...(actions.upload ? { upload: action(actions.upload)! } : {}),
      ...(actions.verify ? { verify: action(actions.verify)! } : {}),
      ...(error
        ? { error: { code: Number(error.code) || 0, message: String(error.message ?? 'object error') } }
        : {}),
    };
  });
}

/** Streams one LFS object and proves its oid and size before the caller binds it. */
export async function streamLfsObject(
  object: LfsPointer,
  download: LfsAction,
  consume: (bytes: Buffer) => Promise<void>,
  request: GithubFetch = networkFetch,
): Promise<void> {
  const authorized = Object.keys(download.header).some(name => name.toLowerCase() === 'authorization');
  const response = await request(download.href, {
    // A credential GitHub attached to this action never follows a redirect.
    redirect: authorized ? 'error' : 'follow',
    signal: networkTimeout(480_000),
    headers: { ...download.header, 'User-Agent': 'NanthAi-Forge' },
  });
  invariant(
    response.ok && response.body,
    'GITHUB_UNAVAILABLE',
    `GitHub LFS could not provide object ${object.oid} (HTTP ${response.status}).`,
  );
  const hash = createHash('sha256'),
    reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      invariant(size <= object.size, 'ARTIFACT_INTEGRITY', 'GitHub LFS object exceeds its pointer size.');
      hash.update(part.value);
      await consume(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength));
    }
  } finally {
    await reader.cancel();
  }
  invariant(
    size === object.size && hash.digest('hex') === object.oid,
    'ARTIFACT_INTEGRITY',
    `GitHub LFS object ${object.oid} differs from its pointer.`,
  );
}

/** Uploads one object GitHub asked for, then calls its verify action if named. */
export async function uploadLfsObject(
  object: LfsBatchObject,
  bytes: Buffer,
  token: string,
  request: GithubFetch = networkFetch,
): Promise<void> {
  invariant(object.upload, 'BAD_ARGUMENT', 'GitHub did not request this LFS upload.');
  invariant(bytes.length === object.size, 'ARTIFACT_INTEGRITY', 'LFS upload bytes differ from the pointer.');
  const put = await request(object.upload.href, {
    method: 'PUT',
    redirect: 'error',
    signal: networkTimeout(480_000),
    headers: {
      'Content-Type': 'application/octet-stream',
      ...object.upload.header,
      'User-Agent': 'NanthAi-Forge',
    },
    body: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length),
  });
  await put.body?.cancel();
  invariant(put.ok, 'GITHUB_UNAVAILABLE', `GitHub LFS refused object ${object.oid} (HTTP ${put.status}).`);
  if (!object.verify) return;
  const sameHost = new URL(object.verify.href).hostname === 'github.com';
  const verified = await request(object.verify.href, {
    method: 'POST',
    redirect: 'error',
    signal: networkTimeout(60_000),
    headers: {
      Accept: lfsMedia,
      'Content-Type': lfsMedia,
      ...(sameHost ? { Authorization: basic(token) } : {}),
      ...object.verify.header,
      'User-Agent': 'NanthAi-Forge',
    },
    body: JSON.stringify({ oid: object.oid, size: object.size }),
  });
  await verified.body?.cancel();
  invariant(verified.ok, 'GITHUB_UNAVAILABLE', `GitHub LFS did not verify object ${object.oid}.`);
}
