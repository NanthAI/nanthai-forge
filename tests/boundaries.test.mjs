import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { capture, indexRepository, DEFAULT_LIMITS } from '../dist/index.js';
import { RepositoryQuery } from '../dist/query.js';
import { fixture, write, git, code } from './helpers.mjs';

test('nested ignore rules, tracked ignored files, sensitive names and generated trees are excluded', t => {
  const root = fixture(t, {
    '.gitignore': 'ignored.ts\n',
    'ignored.ts': 'export const hidden = 1;',
    'src/.gitignore': '*.ts\n!keep.ts\n',
    'src/skip.ts': 'export const skip = 1;',
    'src/keep.ts': 'export const keep = 1;',
    'secrets.ts': 'export const secret = "test-value";',
    '.env.ts': 'export const env = "test-value";',
    'node_modules/pkg/index.ts': 'export const dependency = 1;',
    'main.ts': 'export const main = 1;',
    'view.swift': 'not analyzed',
  });
  git(root, ['add', '-f', 'ignored.ts']);
  const pack = indexRepository(root).pack;
  assert.deepEqual(
    pack.source.files.map(f => f.path),
    ['main.ts', 'src/keep.ts'],
  );
  const serialized = JSON.stringify(pack);
  assert.equal(serialized.includes('test-value'), false);
  assert.equal(serialized.includes('secrets.ts'), false);
  write(root, 'secrets.ts', 'export const secret = "changed";');
  assert.equal(new RepositoryQuery(root).status().freshness, 'current');
});

test('symlinks and hard links are excluded and symlinked cache cannot receive output', t => {
  const outside = fixture(t, { 'private.ts': 'export const privateValue = 1;' });
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  symlinkSync(join(outside, 'private.ts'), join(root, 'link.ts'));
  linkSync(join(outside, 'private.ts'), join(root, 'hard.ts'));
  assert.deepEqual(
    capture(root).source.files.map(f => f.path),
    ['a.ts'],
  );
  symlinkSync(outside, join(root, '.forge'), 'dir');
  assert.throws(() => indexRepository(root), code('UNSAFE_CACHE'));
  assert.equal(existsSync(join(outside, 'index.json')), false);
});

test('repository code, lifecycle scripts and malicious config are not executed', t => {
  const root = fixture(t, {
    'package.json': JSON.stringify({ scripts: { preinstall: 'touch should-not-exist' } }),
    'a.ts':
      'import { writeFileSync } from "node:fs"; writeFileSync("should-not-exist", "bad"); export const a = 1;',
    'tsconfig.json': JSON.stringify({
      extends: 'https://example.invalid/config',
      compilerOptions: { plugins: [{ name: 'never-load' }] },
    }),
  });
  indexRepository(root);
  assert.equal(existsSync(join(root, 'should-not-exist')), false);
  assert.equal(new RepositoryQuery(root).status().analysis.resolution, 'captured-language-structure');
});

test('file and total limits fail without overwriting a valid artifact', t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  indexRepository(root);
  const old = readFileSync(join(root, '.forge/index.json'), 'utf8');
  assert.throws(() => indexRepository(root, { ...DEFAULT_LIMITS, maxFileBytes: 4 }), code('FILE_LIMIT'));
  assert.equal(readFileSync(join(root, '.forge/index.json'), 'utf8'), old);
  write(root, 'b.ts', 'export const b = 2;');
  assert.throws(() => capture(root, { ...DEFAULT_LIMITS, maxFiles: 1 }), code('SOURCE_LIMIT'));
  assert.throws(() => capture(root, { ...DEFAULT_LIMITS, maxTotalBytes: 20 }), code('SOURCE_LIMIT'));
  assert.throws(() => capture(root, { ...DEFAULT_LIMITS, maxPaths: 1 }), code('PATH_LIMIT'));
});

test('invalid encoding and corrupt/malformed artifacts fail explicitly', t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  indexRepository(root);
  const artifactPath = join(root, '.forge/index.json');
  const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  parsed.nodes[0].name = 'tampered';
  writeFileSync(artifactPath, JSON.stringify(parsed));
  assert.throws(() => new RepositoryQuery(root), code('ARTIFACT_INTEGRITY'));
  writeFileSync(artifactPath, '{}');
  assert.throws(() => new RepositoryQuery(root), code('INVALID_ARTIFACT'));
  writeFileSync(artifactPath, '{broken');
  assert.throws(() => new RepositoryQuery(root), code('INVALID_ARTIFACT'));
  writeFileSync(join(root, 'a.ts'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => capture(root), code('INVALID_ENCODING'));
});

test('non-root and missing index fail instead of guessing source scope', t => {
  const root = fixture(t, { 'nested/a.ts': 'export const a = 1;' });
  assert.throws(() => capture(join(root, 'nested')), code('NOT_REPOSITORY_ROOT'));
  assert.throws(() => new RepositoryQuery(root), code('INDEX_MISSING'));
  assert.throws(() => capture(join(root, 'missing')), code('INVALID_ROOT'));
});
