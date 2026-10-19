// SPDX-License-Identifier: Apache-2.0
// Explicit infrastructure/fixture ownership supplements the import graph. Unknown
// paths stay unknown: a filename resemblance is never an independence proof.
export const webTest = path => /^(?:tests\/ui-|tests\/.*-ui\.test)/.test(path);

const ignoreTests = [
  'tests/boundaries.test.mjs',
  'tests/github.test.mjs',
  'tests/index-reuse.test.mjs',
  'tests/native-source-performance.test.mjs',
  'tests/native-workspace-files.test.mjs',
  'tests/source-durability.test.mjs',
];
const manualFixture = path =>
  /^tests\/browser\/.+\.(?:html|tsx?)$/.test(path) ||
  /^tests\/fixtures\/(?:qa-|k-|s1b-|settings-polish\.|readable-url-settings\.|hosted-tree\/)/.test(path);

export function classifyCheckPath(path, files) {
  const domain = (name, prefixes, reason) => ({
    domain: name,
    seeds: [...files.keys()].filter(file => prefixes.some(prefix => file.startsWith(prefix))),
    reason,
  });
  if (path === '.gitignore')
    return { domain: 'tooling', seeds: [path], tests: ignoreTests, reason: 'Repository ignore rules' };
  if (
    [
      '.editorconfig',
      '.prettierignore',
      '.prettierrc',
      '.prettierrc.json',
      'prettier.config.mjs',
      'eslint.config.mjs',
    ].includes(path)
  )
    return { domain: 'tooling', seeds: [path], reason: 'Formatting/lint config; static checks still run' };
  if (path === 'tsconfig.json') return domain('core', ['src/'], 'Core TypeScript configuration');
  if (['web/tsconfig.json', 'web/vite.config.ts', 'web/index.html'].includes(path))
    return domain('web', ['web/src/'], 'Web build configuration');
  if (path === 'convex/tsconfig.json')
    return domain('convex', ['convex/', 'web/src/'], 'Convex TypeScript configuration');
  if (path === 'netlify/tsconfig.json')
    return domain('netlify', ['netlify/'], 'Netlify TypeScript configuration');
  if (/^convex\/_generated\/(?:api|server|dataModel)\.(?:js|d\.ts)$/.test(path))
    return domain('convex', ['convex/', 'web/src/'], 'Generated Convex API and its backend/web consumers');
  if (manualFixture(path))
    return { domain: 'web', seeds: [path], reason: 'Manual browser/QA fixture and UI regression coverage' };
  if (['tests/check-runtime.mjs', 'tests/worker-budget.mjs'].includes(path))
    return domain('tests', ['tests/'], 'Shared test runtime or worker scheduling');
  if (/^scripts\/(?:qa-[a-z]-preview|ui-(?:loader|planned|scale)-shots|s1b-review-shots)\.mjs$/.test(path))
    return { domain: 'web', seeds: [path], reason: 'Manual UI capture tooling' };
  if (/^scripts\/ui-shots(?:\.mjs|\/.+\.mjs)$/.test(path) && files.has(path))
    return { domain: 'web', seeds: [path], reason: 'UI capture tooling and its unit tests' };
  if (!files.has(path)) return null;
  if (/^scripts\/.+\.(?:mjs|js|ts)$/.test(path)) return { domain: 'scripts', seeds: [path] };
  if (/^src\/.+\.ts$/.test(path)) return { domain: 'core', seeds: [path] };
  if (/^web\/src\/.+\.(?:tsx?|css|svg)$/.test(path)) return { domain: 'web', seeds: [path] };
  if (/^convex\/.+\.ts$/.test(path))
    return domain('convex', ['convex/'], 'Convex function references share the backend namespace');
  if (/^netlify\/.+\.(?:m?js|ts)$/.test(path)) return { domain: 'netlify', seeds: [path] };
  if (/^tests\/.+\.(?:mjs|tsx?|json|html)$/.test(path))
    return { domain: 'tests', seeds: [path], requireConsumer: !/^tests\/[^/]+\.test\.mjs$/.test(path) };
  return null;
}
