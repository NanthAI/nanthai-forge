// SPDX-License-Identifier: Apache-2.0
// Advisory execution evidence only: unexecuted branches are not independence proof.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const coverageMarker = '__FORGE_COVERAGE__';
export const coverageMaxAge = 10;
export const fileDigest = text => createHash('sha256').update(text).digest('hex');
const testPath = path => /^tests\/[^/]+\.test\.mjs$/.test(path);
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);

/** Include inherited child-process/worker output; never execute files while decoding. */
export function v8Touched(directory, files, root = process.cwd()) {
  const touched = new Set();
  let reports = 0;
  for (const name of readdirSync(directory)) {
    if (!/^coverage-.+\.json$/.test(name)) continue;
    const data = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
    if (!Array.isArray(data.result)) throw new Error('Incomplete V8 coverage');
    reports++;
    for (const script of data.result) {
      if (!script.url?.startsWith('file:')) continue;
      let path = relative(resolve(root), fileURLToPath(script.url)).split('\\').join('/');
      if (path.startsWith('dist/') && path.endsWith('.js'))
        path = path.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
      if (files.has(path) && script.functions?.some(fn => fn.ranges?.some(range => range.count > 0)))
        touched.add(path);
    }
  }
  if (!reports) throw new Error('Missing V8 coverage');
  return [...touched].sort();
}

/** Source bytes are supplied by the pinned runner, never by a coverage log. */
export function coverageArtifact({ head, files, tests, lines }) {
  if (!oid(head)) return null;
  const rows = new Map();
  for (const line of lines) {
    const index = line.indexOf(coverageMarker);
    if (index < 0) continue;
    try {
      const row = JSON.parse(line.slice(index + coverageMarker.length));
      if (
        row.version !== 1 ||
        row.head !== head ||
        !tests.includes(row.test) ||
        row.complete !== true ||
        !Array.isArray(row.touched) ||
        !row.touched.every(path => files.has(path))
      )
        return null;
      // Replayed/retried reports union their observed execution, never subtract it.
      rows.set(row.test, [...new Set([...(rows.get(row.test) ?? []), ...row.touched])].sort());
    } catch {
      return null;
    }
  }
  if (!tests.length || tests.some(test => !rows.has(test))) return null;
  return {
    version: 1,
    head,
    full: true,
    digests: Object.fromEntries([...files].map(([path, text]) => [path, fileDigest(text)])),
    tests: Object.fromEntries(rows),
  };
}

/** Keep the real selection untouched. Unknown inputs use that exact graph selection. */
export function coverageShadow({ selection, paths, files, coverage }) {
  const fallback = reason => ({
    mode: 'shadow',
    currentCount: selection.tests.length,
    coverageCount: selection.tests.length,
    tests: selection.tests,
    fallback: reason,
  });
  if (!coverage) return fallback('No retained full-run coverage');
  const { artifact, age, head } = coverage;
  if (
    !artifact ||
    artifact.version !== 1 ||
    artifact.full !== true ||
    !oid(head) ||
    artifact.head !== head ||
    !Number.isInteger(age) ||
    age < 0 ||
    age > coverageMaxAge
  )
    return fallback('Coverage source pin or accepted-main age is unavailable/stale');
  if (selection.scope !== 'scoped') return fallback('Full/docs/interaction selection is preserved');
  if (!Array.isArray(paths) || !paths.length) return fallback('Missing changed paths');
  // Match the established static-only Markdown classification.
  paths = paths.filter(path => !/^(?:docs\/.+|[^/]+)\.md$/.test(path));
  // Only ordinary core implementations can be narrowed. Config, schema, generated,
  // fixtures, tooling, tests and unknown domains keep the established graph behavior.
  if (paths.some(path => !/^src\/.+\.ts$/.test(path) || /(?:config|schema|generated|\.d\.ts$)/i.test(path)))
    return fallback('Config/schema/fixtures/tooling or unknown changed domain');
  const tests = [...files.keys()].filter(testPath).sort();
  if (!artifact.digests || !artifact.tests || tests.some(test => !Array.isArray(artifact.tests[test])))
    return fallback('Incomplete test-file coverage');
  // Missing/new/deleted files and drift outside this comparison invalidate the trace.
  const changed = new Set(paths);
  const keys = Object.keys(artifact.digests);
  if (
    keys.length !== files.size ||
    keys.some(path => !files.has(path)) ||
    [...files].some(
      ([path, text]) =>
        !Object.hasOwn(artifact.digests, path) ||
        (!changed.has(path) && artifact.digests[path] !== fileDigest(text)),
    )
  )
    return fallback('New/unknown files or source digest drift outside the comparison');
  if (tests.some(test => !artifact.tests[test].every(path => typeof path === 'string' && files.has(path))))
    return fallback('Malformed coverage paths');
  if (paths.some(path => !tests.some(test => artifact.tests[test].includes(path))))
    return fallback('Changed file has no recorded execution');
  const selected = tests.filter(
    test =>
      artifact.tests[test].some(path => changed.has(path)) ||
      [
        'tests/files.test.mjs',
        'tests/ci-scope.test.mjs',
        'tests/test-impact.test.mjs',
        'tests/check-path-scopes.test.mjs',
      ].includes(test),
  );
  return {
    mode: 'shadow',
    head,
    age,
    currentCount: selection.tests.length,
    coverageCount: selected.length,
    tests: selected,
    fallback: null,
  };
}
