// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';
import { presign } from '../../dist/r2-presign.js';
import { networkFetch, networkTimeout } from '../../dist/network-fetch.js';
import { metadataSource, digestHex } from './legacy-storage-verify.mjs';
import { privateJson } from './legacy-storage-journal.mjs';
export const closureHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = closureHash;
export const catalogDigest = files =>
  hash(
    files
      .map(f => [f.storageId ?? f._id, digestHex(f.sha256), f.bytes ?? f.size])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
const regular = new Set([
  'projectObjects',
  'projectBackups',
  'projectProposals',
  'imports',
  'importArtifacts',
  'derivedArtifacts',
]);
export function bodyRoots(scan, catalog) {
  const roots = [];
  for (const r of scan.references ?? [])
    if (!regular.has(r.table) && catalog.has(r.storageId))
      roots.push({ kind: 'convex', project: r.project, id: r.storageId });
  for (const r of scan.durableReferences ?? []) roots.push({ kind: 'r2', project: r.project, ref: r.ref });
  return roots;
}
const key = n => hash([n.kind, n.project, n.id ?? n.ref]);
const r2Pin = ref => {
  const m = /^r2source:([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(ref);
  if (!m || !Number.isSafeInteger(Number(m[2]))) throw new Error('CLOSURE_PIN_INVALID');
  return { sha256: m[1], bytes: Number(m[2]) };
};
/** Hash raw bytes, inspect decoded text incrementally, including gzip bodies.
 * The overlap retains references split at any stream boundary, never a body. */
export async function inspectBody(response, pin, ids, metrics, provider) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(response.status === 404 ? 'CLOSURE_BODY_MISSING' : 'CLOSURE_READ_FAILED');
  }
  const lengths = [...new Set([...ids].map(id => id.length))],
    storage = new Set(),
    durable = new Set();
  const token = ids.size
    ? new RegExp(
        `(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{${lengths.length === 1 ? lengths[0] : Math.min(...lengths) + ',' + Math.max(...lengths)}}(?![A-Za-z0-9_-])`,
        'g',
      )
    : /(?!) /g;
  const refs = /r2source:[a-f0-9]{64}:(?:0|[1-9][0-9]*)(?![0-9])/g;
  const digest = createHash('sha256');
  let size = 0,
    tail = '';
  const decoder = new TextDecoder();
  function scan(text, final = false) {
    const limit = final ? text.length : Math.max(0, text.length - 128);
    for (const m of text.matchAll(token))
      if (m.index + m[0].length <= limit && ids.has(m[0])) storage.add(m[0]);
    for (const m of text.matchAll(refs)) if (m.index + m[0].length <= limit) durable.add(m[0]);
  }
  async function* raw() {
    for await (const chunk of response.body) {
      size += chunk.length;
      metrics[provider + 'Bytes'] += chunk.length;
      if (size > pin.bytes) throw new Error('CLOSURE_SIZE_MISMATCH');
      digest.update(chunk);
      yield chunk;
    }
  }
  const iterator = raw()[Symbol.asyncIterator](),
    prefix = [];
  let prefixSize = 0;
  while (prefixSize < 2) {
    const p = await iterator.next();
    if (p.done) break;
    prefix.push(p.value);
    prefixSize += p.value.length;
  }
  const signature = Buffer.concat(prefix).subarray(0, 2);
  async function* joined() {
    yield* prefix;
    for (;;) {
      const p = await iterator.next();
      if (p.done) break;
      yield p.value;
    }
  }
  const consume = async source => {
    for await (const chunk of source) {
      const text = tail + decoder.decode(chunk, { stream: true });
      scan(text);
      tail = text.slice(-256);
    }
    scan(tail + decoder.decode(), true);
  };
  if (signature[0] === 31 && signature[1] === 139)
    await pipeline(Readable.from(joined()), createGunzip(), consume);
  else await consume(joined());
  if (size !== pin.bytes || digest.digest('hex') !== digestHex(pin.sha256))
    throw new Error('CLOSURE_DIGEST_MISMATCH');
  return { storageRefs: [...storage], durableRefs: [...durable] };
}
export async function closeBodies(audit, scan, reader, config, out, options = {}) {
  const catalog = new Map(audit.files.map(f => [f.storageId, f])),
    ids = new Set(catalog.keys()),
    catalogSha = catalogDigest(audit.files);
  let cache;
  try {
    cache = JSON.parse(await readFile(out, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (cache && cache.catalogDigest !== catalogSha) throw new Error('CLOSURE_CATALOG_CHANGED');
  cache ??= {
    schema: 1,
    catalogDigest: catalogSha,
    nodes: {},
    metrics: { r2Gets: 0, r2Bytes: 0, convexGets: 0, convexBytes: 0, metadataQueries: 0 },
  };
  const roots = bodyRoots(scan, catalog),
    visited = new Set(),
    references = [],
    failures = [];
  let frontier = roots;
  const fetcher = options.fetcher ?? networkFetch;
  while (frontier.length) {
    const nodes = [];
    for (const n of frontier) {
      const k = key(n);
      if (!visited.has(k)) {
        visited.add(k);
        nodes.push({ ...n, key: k });
      }
    }
    frontier = [];
    const urls = new Map(),
      pending = nodes.filter(n => !cache.nodes[n.key] && n.kind === 'convex');
    for (let start = 0; start < pending.length; start += 100) {
      const page = pending.slice(start, start + 100);
      cache.metrics.metadataQueries++;
      const rows = await reader.page(metadataSource(page.map(n => ({ storageId: n.id }))));
      rows.forEach((row, i) => {
        if (row) urls.set(page[i].id, row);
      });
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (;;) {
          const i = next++;
          if (i >= nodes.length) break;
          const n = nodes[i];
          let body = cache.nodes[n.key];
          try {
            if (!body) {
              let url, pin;
              if (n.kind === 'convex') {
                const f = catalog.get(n.id),
                  row = urls.get(n.id);
                if (!row || digestHex(row.sha256) !== digestHex(f.sha256) || row.size !== f.bytes)
                  throw new Error('CLOSURE_FILE_CHANGED');
                url = row.url;
                pin = { sha256: f.sha256, bytes: f.bytes };
                cache.metrics.convexGets++;
              } else {
                if (!n.project || n.project === 'unattributed' || n.project.startsWith('import:'))
                  throw new Error('CLOSURE_PROJECT_UNKNOWN');
                pin = r2Pin(n.ref);
                cache.metrics.r2Gets++;
                url = await presign({
                  method: 'GET',
                  host: `${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                  path: `/${config.R2_BUCKET}/v1/p/${n.project}/o/${pin.sha256}`,
                  accessKeyId: config.R2_ACCESS_KEY_ID,
                  secretAccessKey: config.R2_SECRET_ACCESS_KEY,
                });
              }
              const response = await fetcher(url, {
                headers: { 'accept-encoding': 'identity' },
                redirect: 'error',
                signal: networkTimeout(120000),
              });
              body = await inspectBody(response, pin, ids, cache.metrics, n.kind);
              cache.nodes[n.key] = body;
            }
            for (const id of body.storageRefs) {
              references.push({
                storageId: id,
                table: 'durableBody',
                document: n.id ?? n.ref,
                project: n.project,
                field: '#body',
              });
              frontier.push({ kind: 'convex', id, project: n.project });
            }
            for (const ref of body.durableRefs) frontier.push({ kind: 'r2', ref, project: n.project });
          } catch (error) {
            failures.push({
              node: n,
              code: /^CLOSURE_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'CLOSURE_READ_FAILED',
            });
          }
        }
      }),
    );
    await privateJson(out, { ...cache, complete: false });
    options.progress?.({ nodes: visited.size, failures: failures.length, ...cache.metrics });
  }
  const proof = {
    schema: 1,
    complete: failures.length === 0,
    catalogDigest: catalogSha,
    roots: roots.length,
    rootDigest: hash(roots.map(key).sort()),
    references,
    failures,
    checkedAt: new Date().toISOString(),
    metrics: cache.metrics,
  };
  proof.sha256 = hash(proof);
  await privateJson(out, { ...cache, ...proof });
  return proof;
}
