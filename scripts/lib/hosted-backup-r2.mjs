// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { presign } from '../../dist/r2-presign.js';
import { failure } from './hosted-durability-compare.mjs';

const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const unescape = value =>
  value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const tags = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => unescape(m[1]));
const tag = (xml, name) => tags(xml, name)[0];

// The existing path-style S3 signer and R2 environment names are shared with blob storage.
// Raw provider errors, response bodies and signed URLs must never reach CLI output.
export function r2Client(env = process.env, fetcher = fetch) {
  const {
    R2_ACCOUNT_ID: accountId,
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) throw failure('R2_NOT_CONFIGURED');
  async function request(method, key, query = {}, body, headers = {}) {
    try {
      const url = await presign({
        method,
        host: `${accountId}.r2.cloudflarestorage.com`,
        path: `/${bucket}/${key}`,
        accessKeyId,
        secretAccessKey,
        query,
        headers,
      });
      const response = await fetcher(url, {
        method,
        headers: {
          ...headers,
          ...(method === 'GET' || method === 'HEAD' ? { 'accept-encoding': 'identity' } : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(120_000),
      });
      if (method === 'HEAD' && response.status === 404) return null;
      if (!response.ok) throw failure('BACKUP_R2_FAILED');
      return response;
    } catch {
      throw failure('BACKUP_R2_FAILED');
    }
  }
  return {
    async head(key) {
      const r = await request('HEAD', key);
      if (r && r.headers.get('content-length') === null) throw failure('BACKUP_R2_FAILED');
      return (
        r && { size: Number(r.headers.get('content-length')), sha256: r.headers.get('x-amz-meta-sha256') }
      );
    },
    async manifest(key) {
      try {
        const response = await request('GET', key);
        const chunks = [];
        let size = 0;
        for await (const bytes of response.body) {
          size += bytes.length;
          if (size > 65536) throw failure('BACKUP_STATE_INVALID');
          chunks.push(bytes);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw failure('BACKUP_STATE_INVALID');
      }
    },
    async digest(key) {
      const response = await request('GET', key);
      const hash = createHash('sha256');
      let size = 0;
      for await (const bytes of response.body) {
        hash.update(bytes);
        size += bytes.length;
      }
      return { size, sha256: hash.digest('hex') };
    },
    async create(key, sha256) {
      // The object key embeds the saved operation ID. Discover an initiation whose
      // response was lost before creating another multipart upload for that operation.
      let marker = {};
      for (;;) {
        const listing = await request('GET', '', { uploads: '', prefix: key, ...marker });
        const xml = await listing.text();
        for (const upload of tags(xml, 'Upload')) {
          if (tag(upload, 'Key') === key && tag(upload, 'UploadId')) return tag(upload, 'UploadId');
        }
        if (tag(xml, 'IsTruncated') !== 'true') break;
        const nextKey = tag(xml, 'NextKeyMarker'),
          nextId = tag(xml, 'NextUploadIdMarker');
        if (!nextKey || (marker['key-marker'] === nextKey && marker['upload-id-marker'] === nextId))
          throw failure('BACKUP_R2_FAILED');
        marker = { 'key-marker': nextKey, ...(nextId ? { 'upload-id-marker': nextId } : {}) };
      }
      const response = await request('POST', key, { uploads: '' }, undefined, {
        'x-amz-meta-sha256': sha256,
      });
      const id = tag(await response.text(), 'UploadId');
      if (!id) throw failure('BACKUP_R2_FAILED');
      return id;
    },
    async part(key, uploadId, number, bytes) {
      const headers = { 'content-md5': createHash('md5').update(bytes).digest('base64') };
      const response = await request('PUT', key, { uploadId, partNumber: String(number) }, bytes, headers);
      const etag = response.headers.get('etag');
      if (!etag) throw failure('BACKUP_R2_FAILED');
      return etag;
    },
    async complete(key, uploadId, parts) {
      const body =
        '<CompleteMultipartUpload>' +
        parts
          .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escape(etag)}</ETag></Part>`)
          .join('') +
        '</CompleteMultipartUpload>';
      const response = await request('POST', key, { uploadId }, body, { 'content-type': 'application/xml' });
      const xml = await response.text();
      if (/<Error[>\s]/.test(xml) || !tag(xml, 'ETag')) throw failure('BACKUP_R2_FAILED');
    },
    async put(key, bytes, sha256) {
      await request('PUT', key, {}, bytes, {
        'if-none-match': '*',
        'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
        'x-amz-meta-sha256': sha256,
      });
    },
    async *pages(prefix) {
      let cursor;
      do {
        const query = {
          'list-type': '2',
          'max-keys': '1000',
          prefix,
          'encoding-type': 'url',
          ...(cursor ? { 'continuation-token': cursor } : {}),
        };
        const response = await request('GET', '', query);
        const xml = await response.text();
        yield tags(xml, 'Key').map(decodeURIComponent);
        const next = tag(xml, 'NextContinuationToken');
        if (tag(xml, 'IsTruncated') !== 'true') break;
        if (!next || next === cursor) throw failure('BACKUP_R2_FAILED');
        cursor = next;
      } while (true);
    },
    async list(prefix) {
      const keys = [];
      for await (const page of this.pages(prefix)) keys.push(...page);
      return keys;
    },
    async remove(key) {
      await request('DELETE', key);
    },
  };
}
