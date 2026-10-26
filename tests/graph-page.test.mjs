// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { indexRepository } from '../dist/index.js';
import { hostedQuery } from '../dist/hosted-query.js';

test('hosted graph uses the same validated graph owner and never fabricates relationships', async t => {
  const files = {
    'a.ts': 'export const a=1;',
    'b.ts': 'import {a} from "./a"; import external from "outside"; export const b=a;',
  };
  const root = fixture(t, files),
    { pack } = await indexRepository(root);
  const repository = {
    full_name: 'example/source',
    html_url: 'https://github.com/example/source',
    private: false,
    license: null,
  };
  const artifact = { pack, content: files, documents: {}, repository };
  const result = hostedQuery(artifact, 'graph?limit=100', pack.source.gitHead, repository);
  assert.deepEqual(result.relationships.results, pack.imports);
  assert.equal(result.files.total, 2);
  assert.throws(
    () => hostedQuery(artifact, 'graph?state=other', pack.source.gitHead),
    /different source state/,
  );
});
