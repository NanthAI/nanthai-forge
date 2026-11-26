// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceLiteralFindings } from '../scripts/check-instance-literals.mjs';
import { docsSourceLink } from '../scripts/docs-source-link.mjs';
import { helpTopicText } from '../dist/help-topics.js';
import { moduleUrl } from './convex-module.mjs';

const { instanceContact } = await import(moduleUrl('../web/src/instance-contact.ts'));

test('the instance literal guard catches new product routing and permits the listed operator cases', () => {
  const origin = 'https://dev.forge.nanthai.tech';
  const repo = 'NanthAI/nanthai-forge';
  const deployment = 'nanthai-forge-dev';
  assert.equal(instanceLiteralFindings('src/router.ts', [origin, repo, deployment].join('\n')).length, 3);
  assert.deepEqual(instanceLiteralFindings('src/forge-site.ts', origin), []);
  assert.equal(instanceLiteralFindings('src/forge-site.ts', origin + '\n' + origin).length, 1);
  assert.deepEqual(instanceLiteralFindings('scripts/bench-t3code/fixture.mjs', repo), []);
  assert.deepEqual(instanceLiteralFindings('.github/workflows/deploy.yml', deployment), []);
});

test('generated documentation can cite an exact source tree', () => {
  assert.equal(
    docsSourceLink('docs/a b.md', 'https://code.example/org/forge/tree/abc/'),
    'https://code.example/org/forge/tree/abc/docs/a%20b.md',
  );
  assert.throws(
    () => docsSourceLink('source.ts', 'https://key@code.example/tree/abc'),
    /without credentials/,
  );
});

test('operator and legal contacts use the configured address and fall back when no address is usable', () => {
  assert.deepEqual(instanceContact(' help+forge@example.com '), {
    href: 'mailto:help%2Bforge@example.com',
    address: 'help+forge@example.com',
  });
  assert.equal(instanceContact(undefined), null);
  assert.equal(instanceContact('help@example.com?bcc=other@example.com'), null);
});

test('landing message help applies the byte limit to a Forge landing without requiring a mirror', () => {
  assert.match(helpTopicText('limits'), /the landing message can be at most 16384 UTF-8 bytes/);
});
