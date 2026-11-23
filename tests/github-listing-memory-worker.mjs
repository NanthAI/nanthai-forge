// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { listGithubTree } from '../dist/github-archive-source.js';
import { ListingPageWriter } from '../dist/github-listing-codec.js';

const files = Number(process.argv[2]);
const perTree = 4096;
const hex = n => n.toString(16).padStart(40, '0');
const root = hex(1);
const leaves = Math.ceil(files / perTree);
const fetchTree = async raw => {
  const url = new URL(raw);
  const sha = url.pathname.split('/').at(-1);
  if (sha === root) {
    const recursive = url.searchParams.has('recursive');
    return Response.json({
      sha,
      truncated: recursive,
      tree: recursive
        ? []
        : Array.from({ length: leaves }, (_, i) => ({
            path: 'dir-' + String(i).padStart(4, '0'),
            mode: '040000',
            type: 'tree',
            sha: hex(i + 2),
          })),
    });
  }
  const start = (parseInt(sha, 16) - 2) * perTree;
  return Response.json({
    sha,
    truncated: false,
    tree: Array.from({ length: Math.min(perTree, files - start) }, (_, i) => ({
      path: String(i).padStart(5, '0') + '-source-tree-fixture-'.repeat(4) + '文😀.txt',
      type: 'blob',
      mode: '100644',
      sha: hex(start + i),
      size: 20,
    })),
  });
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const writer = new ListingPageWriter(async bytes => ({ sha256: digest(bytes), size: bytes.length }));
const totals = await listGithubTree('fixture/large', root, undefined, fetchTree, writer);
assert.deepEqual(totals, { files, totalBytes: files * 20, submodules: 0 });
const index = await writer.finish(root, totals);
assert.equal(
  index.pages.reduce((sum, page) => sum + page.rows, 0),
  files,
);
console.log(
  JSON.stringify({
    files,
    pages: index.pages.length,
    digest: digest(JSON.stringify(index)),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
