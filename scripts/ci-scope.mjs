// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const full = reason => ({ scope: 'full', reason });
const safePath = path =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.split('/').some(part => ['', '.', '..'].includes(part)) &&
  !/[\x00-\x1f\x7f\ufffd\\*?\[\]{}!]/.test(path);
const documentation = path => /^(?:docs\/.+|[^/]+)\.md$/.test(path);

// Missing package metadata is uncertain; packaged Markdown uses the docs inventory check.
export function classifyPaths(paths, manifests) {
  if (!Array.isArray(paths) || paths.length === 0) return full('No changed paths');
  if (
    !Array.isArray(manifests) ||
    manifests.length !== 2 ||
    manifests.some(
      manifest => !Array.isArray(manifest?.files) || manifest.files.some(path => !safePath(path)),
    )
  )
    return full('Unknown package file selection');
  for (const path of paths) {
    if (!safePath(path) || !documentation(path)) return full('Change outside documentation allowlist');
  }
  return {
    scope: 'docs',
    reason: 'Only Markdown documentation changed; foundation and package document validation',
  };
}

export function classifyGitChanges({ cwd = process.cwd(), eventName, base, head }) {
  if (!['pull_request', 'push'].includes(eventName)) return full('Manual or unknown event');
  const validSha = sha =>
    typeof sha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) && !/^0+$/.test(sha);
  if (!validSha(base) || !validSha(head)) return full('Missing or invalid exact commit pins');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    for (const sha of [base, head]) git('rev-parse', '--verify', `${sha}^{commit}`);
    const names = git(
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-only',
      '-z',
      base,
      head,
      '--',
    );
    if (!names || !names.endsWith('\0')) return full('No complete changed-path list');
    const manifests = [base, head].map(sha => JSON.parse(git('show', `${sha}:package.json`)));
    return classifyPaths(names.slice(0, -1).split('\0'), manifests);
  } catch {
    return full('Commit, diff or package metadata unavailable');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = classifyGitChanges({
    eventName: process.env.CI_EVENT_NAME,
    base: process.env.CI_BASE_SHA,
    head: process.env.CI_HEAD_SHA,
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${result.scope}\n`);
  console.log(JSON.stringify(result));
}
