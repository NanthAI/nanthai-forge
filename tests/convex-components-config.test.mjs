// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Convex's loader gives imported definitions their paths before running app.use.
// Bundle the real pinned definitions with that same metadata, without deploying.
async function application() {
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
          builder.onLoad({ filter: /node_modules\/.*\/convex\.config\.js$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8');
            return {
              contents:
                source.replace('export default ', 'const testDefinition = ') +
                `\ntestDefinition.componentDefinitionPath = ${JSON.stringify(path)}; testDefinition.defaultName = testDefinition._name; export default testDefinition;`,
              loader: 'js',
            };
          });
        },
      },
    ],
  });
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
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
test('dev deployment incident: required component credentials cannot bind optional parent variables', async () => {
  const app = await application();
  validateEnvironmentBindings(app);
  // Reproduce the rejected deployment contract without credentials or network I/O.
  const declaration = app._env.AUTH_GITHUB_CLIENT_ID;
  app._env.AUTH_GITHUB_CLIENT_ID = { ...declaration, isOptional: 'optional' };
  assert.throws(
    () => validateEnvironmentBindings(app),
    /authGithub.CLIENT_ID needs a required parent binding/,
  );
});
