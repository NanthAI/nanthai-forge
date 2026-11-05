// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';
// Explicit infrastructure/fixture ownership supplements the import graph. Unknown
// paths stay unknown: a filename resemblance is never an independence proof.
export const webTest = path => /^(?:tests\/ui-|tests\/.*-ui\.test)/.test(path);

/** A non-source file in a folder under scripts/ or tests/ (shell, Python, notes)
 * is data to the code that runs or reads it, which the selector never parses.
 * Its observers are its sibling code (relative spawns, folder walks) and any
 * file naming it or one of its folders. Product code or the package manifest
 * naming it keeps the full suite; so does a top-level file, whose folder name
 * says nothing (2026-11-01: scripts/bench-t3code/oracle.sh forced every main
 * race re-check of a slow landing back to the full suite). */
function scriptAsset(path, files) {
  const match = /^(scripts|tests)\/((?:[^/]+\/)+)([^/]+)$/.exec(path);
  if (!match || /\.(?:[cm]?js|[cm]?tsx?|css|json|svg|html)$/.test(path) || manualFixture(path))
    return undefined;
  const [, top, nested, name] = match;
  const folder = `${top}/${nested.slice(0, -1)}`;
  const segments = nested.slice(0, -1).split('/');
  const folders = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  const readers = [...files.keys()].filter(file => {
    if (file === path) return false;
    if (file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/')) return true;
    const text = files.get(file);
    return text.includes(name) || folders.some(f => text.includes(`${f}/`) || text.includes(`'${f}'`));
  });
  if (readers.some(file => /^(?:src|web|convex|netlify)\/|^package(?:-lock)?\.json$/.test(file))) return null;
  return {
    domain: top === 'tests' ? 'tests' : 'scripts',
    seeds: [path, ...readers],
    reason: 'Script or fixture data and the code beside or naming it',
  };
}
const manualFixture = path =>
  /^tests\/browser\/.+\.(?:html|tsx?)$/.test(path) ||
  /^tests\/fixtures\/(?:qa-|k-|s1b-|settings-polish\.|readable-url-settings\.|hosted-tree\/)/.test(path);

export function classifyCheckPath(path, files) {
  const domain = (name, prefixes, reason) => ({
    domain: name,
    seeds: [...files.keys()].filter(file => prefixes.some(prefix => file.startsWith(prefix))),
    reason,
  });
  // Root configuration and non-Markdown docs/evals can alter any behaviour.
  // Returning unknown selects full coverage, including for deleted files.
  if (!path.includes('/') || path.startsWith('docs/') || path.startsWith('evals/')) return null;
  if (['web/tsconfig.json', 'web/vite.config.ts', 'web/index.html'].includes(path))
    return domain('web', ['web/src/'], 'Web build configuration');
  if (path === 'convex/tsconfig.json')
    return domain('convex', ['convex/', 'web/src/'], 'Convex TypeScript configuration');
  if (path === 'netlify/tsconfig.json')
    return domain('netlify', ['netlify/'], 'Netlify TypeScript configuration');
  // A declaration file only changes typechecking (static checks always run) and
  // the tests that load its runtime twin; no other backend file reads its text.
  const declaration = path.match(
    /^((?:convex\/_generated\/(?:api|server|dataModel)|scripts\/[^/]+))\.d\.m?ts$/,
  );
  if (declaration && files.has(path)) {
    const twin = ['.mjs', '.js', '.mts', '.ts']
      .map(ext => declaration[1] + ext)
      .find(file => files.has(file));
    return {
      domain: declaration[1].startsWith('scripts/') ? 'scripts' : 'convex',
      seeds: twin ? [path, twin] : [path],
      reason: 'Declaration file: typecheck plus tests loading its module',
    };
  }
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
  // Agent skill docs are read by name: select the code and tests naming them.
  if (/^skills\/.+\.md$/.test(path)) {
    const folder = path.slice(0, path.lastIndexOf('/'));
    const name = path.slice(folder.length + 1);
    // Packagers run in CI (package-smoke), not under the test suite; manifests list everything.
    const readers = [...files.keys()].filter(file => {
      if (/^package(?:-lock)?\.json$|^scripts\/package-/.test(file)) return false;
      const text = files.get(file);
      return text.includes(path) || (text.includes(`${folder}/`) && text.includes(name));
    });
    if (!readers.length) return null;
    // Product code that reads the document is covered by the tests naming that module.
    const modules = readers
      .filter(file => file.startsWith('src/'))
      .map(file => posix.basename(file).replace(/\.[^.]+$/, ''));
    return {
      domain: 'skills',
      seeds: [path, ...readers.filter(file => !file.startsWith('src/'))],
      tests: [...files.keys()].filter(file => {
        if (!/^tests\/[^/]+\.test\.mjs$/.test(file)) return false;
        const text = files.get(file);
        return modules.some(
          module =>
            text.includes(module) ||
            (/-cli$/.test(module) &&
              text.includes(`'${module.slice(0, -4)}'`) &&
              /dist\/cli|nforge/.test(text)),
        );
      }),
      reason: 'Agent skill document and the tests that read it directly or through the module that does',
    };
  }
  // A workflow product code dispatches is the landing check itself; any other workflow
  // runs outside the suite, and only the tests and scripts that read it can observe it.
  const workflow = path.match(/^\.github\/workflows\/([^/]+\.ya?ml)$/)?.[1];
  if (workflow) {
    const product = /^(?:src|convex|web\/src|netlify)\//;
    if ([...files].some(([file, text]) => product.test(file) && text.includes(workflow))) return null;
    return {
      domain: 'tooling',
      seeds: [
        path,
        ...[...files.keys()].filter(
          file =>
            /^(?:tests|scripts)\//.test(file) &&
            (files.get(file).includes(workflow) || files.get(file).includes('.github/workflows')),
        ),
      ],
      reason: 'GitHub workflow outside the landing check and the tests and scripts that read it',
    };
  }
  // Planning notes are read only by the code naming them or their folder.
  if (/^plans\/[^/]+\.md$/.test(path))
    return {
      domain: 'tooling',
      seeds: [
        path,
        ...[...files.keys()].filter(
          file => /^(?:tests|scripts)\//.test(file) && /plans\//.test(files.get(file)),
        ),
      ],
      reason: 'Planning note and the tests and scripts that read plans',
    };
  // The TLA+ queue model and its run configurations are read only by the model runner and by the
  // guard scripts naming the folder. The model itself runs as `npm run model:landing-queue`
  // (a TLC run that needs the pinned JAR), not as a node test: preflight reports that command and
  // runs the tests that read the model. The package manifest only names the run script.
  if (/^models\/landing-queue\/[^/]+\.(?:tla|cfg|md|mjs)$/.test(path))
    return {
      domain: 'models',
      seeds: [
        path,
        ...[...files.keys()].filter(
          file =>
            /^(?:tests|scripts|src)\//.test(file) &&
            file !== path &&
            files.get(file).includes('models/landing-queue'),
        ),
      ],
      reason: 'Landing queue model and the guards reading it; run the model with npm run model:landing-queue',
    };
  const asset = scriptAsset(path, files);
  if (asset !== undefined) return asset;
  if (!files.has(path)) return null;
  if (/^scripts\/.+\.(?:mjs|js|ts)$/.test(path)) return { domain: 'scripts', seeds: [path] };
  if (/^src\/.+\.ts$/.test(path)) return { domain: 'core', seeds: [path] };
  if (/^web\/src\/.+\.(?:tsx?|css|svg)$/.test(path)) return { domain: 'web', seeds: [path] };
  // Schema and deployment config shape every function; other modules are graphed
  // through imports and function references (api.*, internal.*, "module:function").
  if (/^convex\/(?:schema|convex\.config|auth\.config)\.ts$/.test(path))
    return domain('convex', ['convex/'], 'Convex schema or deployment config shares the backend namespace');
  if (/^convex\/.+\.ts$/.test(path))
    return { domain: 'convex', seeds: [path], reason: 'Convex importers and function-reference callers' };
  if (/^netlify\/.+\.(?:m?js|ts)$/.test(path)) return { domain: 'netlify', seeds: [path] };
  if (/^tests\/.+\.(?:mjs|tsx?|json|html)$/.test(path))
    return { domain: 'tests', seeds: [path], requireConsumer: !/^tests\/[^/]+\.test\.mjs$/.test(path) };
  return null;
}
