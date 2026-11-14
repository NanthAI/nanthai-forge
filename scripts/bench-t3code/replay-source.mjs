// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { gitFailure } from '../../dist/work-git-command.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Synthetic set union only; diff3 ancestors are evidence, not new contributions. */
export function contributionUnion(text, allowed) {
  let base = false;
  const lines = [];
  for (const line of text.split('\n')) {
    if (/^<<<<<<<(?: |$)/.test(line)) {
      base = false;
      continue;
    }
    if (/^\|\|\|\|\|\|\|(?: |$)/.test(line)) {
      base = true;
      continue;
    }
    if (/^=======$/.test(line)) {
      base = false;
      continue;
    }
    if (/^>>>>>>>(?: |$)/.test(line)) {
      base = false;
      continue;
    }
    if (!line || base) continue;
    if (!allowed.has(line)) throw Error('Diagnostic divergence: unexpected synthetic contribution');
    lines.push(line);
  }
  return [...new Set(lines)].sort().join('\n') + '\n';
}
export function resolveContributions(root, paths, expected) {
  for (const path of paths) {
    if (!expected.has(path) || !resolve(root, path).startsWith(resolve(root) + '/'))
      throw Error('Diagnostic divergence: unexpected conflict path');
    const file = join(root, path);
    writeFileSync(
      file,
      contributionUnion(readFileSync(file, 'utf8'), new Set(expected.get(path).trim().split('\n'))),
    );
  }
}
/** Bounded Git transport; lazy per-object fetches are disabled for local oracle reads. */
async function gitBatch(root, args, input = '') {
  return new Promise((done, fail) => {
    const child = spawn('git', ['-C', root, ...args], {
      // Commands with no input can exit before an empty stdin write on Linux.
      stdio: [input.length ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    });
    const chunks = [],
      stderr = [];
    let size = 0,
      stderrSize = 0,
      failure;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1 << 20) {
        child.kill();
        fail(Error('Diagnostic source exceeds synthetic fixture'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (stderrSize < 4000) stderr.push(chunk.subarray(0, 4000 - stderrSize));
      stderrSize += chunk.length;
    });
    child.on('error', error => {
      failure = error;
    });
    child.on('close', (status, signal) =>
      status === 0 && !failure
        ? done(Buffer.concat(chunks))
        : fail(gitFailure({ status, signal, code: failure?.code, stderr: Buffer.concat(stderr) }, args)),
    );
    // A failed Git process can close stdin first; close retains its real exit and redacted error.
    child.stdin?.on('error', error => {
      failure = error;
    });
    child.stdin?.end(input);
  });
}
/** One pinned tree, at most one batched missing-blob fetch, then one local content batch. */
export async function gitSource(root, head, paths, { batch = gitBatch } = {}) {
  const tree = await batch(root, ['ls-tree', '-z', head, '--', ...paths]);
  const objects = tree
    .toString()
    .split('\0')
    .filter(Boolean)
    .map(line => line.split('\t')[0].split(' ')[2]);
  const checks = await batch(root, ['cat-file', '--batch-check'], objects.map(id => id + '\n').join(''));
  const missing = checks
    .toString()
    .split('\n')
    .filter(line => line.endsWith(' missing'))
    .map(line => line.split(' ')[0]);
  // One pack request for the complete missing set; no per-file network fallback.
  if (missing.length) await batch(root, ['fetch', '--no-write-fetch-head', 'origin', ...missing]);
  const bytes = await batch(root, ['cat-file', '--batch'], paths.map(path => `${head}:${path}\n`).join(''));
  const files = new Map();
  let offset = 0;
  for (const path of paths) {
    const end = bytes.indexOf(10, offset),
      header = bytes.subarray(offset, end).toString();
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) throw Error('Diagnostic source missing a fixture blob');
    const size = Number(m[1]);
    offset = end + 1;
    files.set(path, bytes.subarray(offset, offset + size).toString());
    offset += size + 1;
  }
  return { head, files };
}
