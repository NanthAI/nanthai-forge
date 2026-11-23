// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Convex's loader gives imported definitions their paths before running app.use.
// Bundle the real pinned definitions with that same metadata, without deploying.
async function application(env = {}) {
  const result = await build({
    entryPoints: ['convex/convex.config.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'component-definition-paths',
        setup(builder) {
          builder.onLoad({ filter: /\/convex\.config\.[jt]s$/ }, async ({ path }) => {
            if (path === resolve('convex/convex.config.ts')) return;
            const source = await readFile(path, 'utf8');
            return {
              contents:
                source.replace('export default ', 'const testDefinition = ') +
                `\ntestDefinition.componentDefinitionPath = ${JSON.stringify(path)}; testDefinition.defaultName = testDefinition._name; export default testDefinition;`,
              loader: path.endsWith('.ts') ? 'ts' : 'js',
            };
          });
        },
      },
    ],
  });
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, process: { env } });
  return module.exports.default;
}
function validateEnvironmentBindings(parent) {
  for (const [alias, child, bindings] of parent._childComponents) {
    const name = alias ?? child.defaultName;
    for (const [key, declaration] of Object.entries(child._env)) {
      const value = bindings[key];
      if (declaration.isOptional === 'optional') continue;
      if (typeof value === 'string') continue;
      const reference = value?.__envVarRef;
      assert(reference && parent._env[reference], `${name}.${key} needs a declared parent binding`);
      assert.equal(
        parent._env[reference].isOptional,
        'required',
        `${name}.${key} needs a required parent binding`,
      );
    }
    validateEnvironmentBindings(child);
  }
}
test('OAuth credentials are optional for deployment while required child inputs remain valid', async () => {
  for (const env of [
    {},
    { AUTH_GITHUB_CLIENT_ID: 'synthetic-id' },
    {
      AUTH_GITHUB_CLIENT_ID: 'synthetic-id',
      AUTH_GITHUB_CLIENT_SECRET: 'synthetic-secret',
    },
  ]) {
    const app = await application(env);
    for (const name of ['AUTH_GITHUB_CLIENT_ID', 'AUTH_GITHUB_CLIENT_SECRET'])
      assert.equal(app._env[name].isOptional, 'optional');
    validateEnvironmentBindings(app);
    const [, , bindings] = app._childComponents.find(
      ([alias, child]) => (alias ?? child.defaultName) === 'authGithub',
    );
    assert.equal(bindings.CLIENT_ID, env.AUTH_GITHUB_CLIENT_ID ?? '');
    assert.equal(bindings.CLIENT_SECRET, env.AUTH_GITHUB_CLIENT_SECRET ?? '');
    // Preserve the original incident guard: an optional reference still cannot
    // satisfy the real pinned library's required child declaration.
    bindings.CLIENT_ID = app.env.AUTH_GITHUB_CLIENT_ID;
    assert.throws(
      () => validateEnvironmentBindings(app),
      /authGithub.CLIENT_ID needs a required parent binding/,
    );
  }
});
