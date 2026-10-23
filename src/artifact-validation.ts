// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { identity, graphIdentity } from './hash.js';
import { safeRelative } from './files.js';
import type { GraphPack, Locator } from './types.js';

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown): v is string => typeof v === 'string';
const position = (v: unknown): boolean =>
  record(v) && integer(v.offset) && integer(v.line) && v.line > 0 && integer(v.column) && v.column > 0;
function locator(v: unknown): v is Locator {
  return (
    record(v) &&
    text(v.file) &&
    safeRelative(v.file) &&
    hash(v.digest) &&
    position(v.start) &&
    position(v.end) &&
    Number((v.end as Record<string, unknown>).offset) >= Number((v.start as Record<string, unknown>).offset)
  );
}

export function validateArtifact(input: unknown): GraphPack {
  const bad = () =>
    invariant(false, 'INVALID_ARTIFACT', 'Invalid or incompatible graph artifact; rebuild the index.');
  if (
    !record(input) ||
    input.schemaVersion !== 1 ||
    !hash(input.id) ||
    !record(input.source) ||
    !record(input.analysis)
  )
    bad();
  const p = input as Record<string, unknown>;
  const s = p.source as Record<string, unknown>;
  const a = p.analysis as Record<string, unknown>;
  if (
    !hash(s.id) ||
    (s.gitHead !== null && !(text(s.gitHead) && /^[a-f0-9]{40,64}$/.test(s.gitHead))) ||
    ![
      'included-typescript-working-tree',
      'included-typescript-git-revision',
      'included-language-working-tree',
      'included-language-git-revision',
    ].includes(String(s.scope)) ||
    !hash(s.inventoryDigest) ||
    !record(s.policy) ||
    !record(s.excluded) ||
    !Array.isArray(s.files)
  )
    bad();
  const policy = s.policy as Record<string, unknown>;
  if ((policy.version !== 1 && policy.version !== 2) || !record(policy.limits)) bad();
  if (String(s.scope).startsWith('included-language-') !== (policy.version === 2)) bad();
  const limits = policy.limits as Record<string, unknown>;
  for (const key of ['maxPaths', 'maxFiles', 'maxFileBytes', 'maxTotalBytes']) {
    if (!integer(limits[key]) || Number(limits[key]) < 1 || Number(limits[key]) > 128 * 1024 * 1024) bad();
  }
  const legacy =
    a.provider === 'typescript-compiler' &&
    a.configVersion === 1 &&
    a.resolution === 'captured-relative-ts-only';
  const multi =
    a.provider === 'forge-language-analyzers' &&
    a.configVersion === 2 &&
    a.resolution === 'captured-language-structure';
  if (
    (!legacy && !multi) ||
    !text(a.version) ||
    a.coverage !== 'partial' ||
    !Array.isArray(a.limitations) ||
    !a.limitations.every(text)
  )
    bad();
  if (
    multi &&
    (!Array.isArray(a.languages) ||
      a.languages.length !== 5 ||
      new Set(a.languages.map(v => (record(v) ? v.language : ''))).size !== 5 ||
      !a.languages.every(
        v =>
          record(v) &&
          ['typescript', 'javascript', 'python', 'java', 'rust'].includes(String(v.language)) &&
          text(v.parser) &&
          text(v.version) &&
          Array.isArray(v.relationships) &&
          v.relationships.every(text),
      ))
  )
    bad();
  for (const key of ['nodes', 'imports', 'references', 'issues']) if (!Array.isArray(p[key])) bad();
  const fileMap = new Map<string, string>();
  for (const f of s.files as unknown[]) {
    if (!record(f) || !text(f.path) || !safeRelative(f.path) || !hash(f.digest) || !integer(f.bytes)) {
      bad();
      continue;
    }
    if (fileMap.has(f.path)) bad();
    fileMap.set(f.path, f.digest);
  }
  const checkLocator = (v: unknown) => {
    if (!locator(v) || fileMap.get(v.file) !== v.digest) bad();
  };
  const nodeIds = new Set<string>();
  for (const n of p.nodes as unknown[]) {
    if (!record(n) || !text(n.id) || !text(n.name) || !text(n.kind) || typeof n.exported !== 'boolean') {
      bad();
      continue;
    }
    if (nodeIds.has(n.id)) bad();
    nodeIds.add(n.id);
    checkLocator(n.locator);
  }
  for (const e of p.imports as unknown[]) {
    if (
      !record(e) ||
      !text(e.from) ||
      !fileMap.has(e.from) ||
      !text(e.specifier) ||
      (e.target !== null && (!text(e.target) || !fileMap.has(e.target))) ||
      !['resolved', 'external', 'unresolved'].includes(String(e.resolution))
    ) {
      bad();
      continue;
    }
    checkLocator(e.locator);
  }
  for (const e of p.references as unknown[]) {
    if (!record(e) || !text(e.target) || !nodeIds.has(e.target)) {
      bad();
      continue;
    }
    checkLocator(e.locator);
  }
  for (const i of p.issues as unknown[]) {
    if (!record(i) || !text(i.file) || !fileMap.has(i.file) || !text(i.code) || !integer(i.offset)) bad();
  }
  const { id: sourceId, excluded: _excluded, ...sourceBody } = s;
  void _excluded;
  const { id: packId, ...body } = p;
  invariant(
    identity(sourceBody) === sourceId && graphIdentity(body as Omit<GraphPack, 'id'>) === packId,
    'ARTIFACT_INTEGRITY',
    'Graph artifact content does not match its identity; rebuild the index.',
  );
  return input as GraphPack;
}
