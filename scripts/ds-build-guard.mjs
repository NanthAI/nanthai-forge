// SPDX-License-Identifier: Apache-2.0
// Build guard for the Phase 7 shared base (DESIGN.md, "Using the system"): only the design system's behaviour
// folder imports the headless layer, no second behaviour, drag or motion library is imported anywhere, the layer never
// reaches the first-paint chunks, and its own chunks stay inside web-ds-layer-gzip in src/speed-budgets.json.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

export const LAYER_DIR = '/web/src/ds/behaviour/';
/** Gzip bytes allowed for the layer's own chunks: web-ds-layer-gzip in src/speed-budgets.json. */
export const LAYER_GZIP_BUDGET = JSON.parse(
  readFileSync(new URL('../src/speed-budgets.json', import.meta.url), 'utf8'),
).budgets.find(budget => budget.id === 'web-ds-layer-gzip').max;
const LAYER =
  /^(?:react-aria-components|react-aria|react-stately|@react-aria\/[^/]+|@react-stately\/[^/]+)(?:\/|$)/;
// Behaviour, drag and motion libraries the decision rejected or that would duplicate the layer.
const SECOND = new RegExp(
  '^(?:' +
    [
      '@dnd-kit/[^/]+',
      '@base-ui(?:-components)?/[^/]+',
      '@radix-ui/[^/]+',
      'radix-ui',
      '@headlessui/[^/]+',
      '@ariakit/[^/]+',
      'ariakit',
      'react-dnd',
      '@hello-pangea/dnd',
      'react-beautiful-dnd',
      '@ui-sdk/[^/]+',
      'downshift',
      'cmdk',
      'kbar',
      'vaul',
      '@floating-ui/react(?:-dom)?',
      'sortablejs',
      'react-sortablejs',
      '@atlaskit/pragmatic-drag-and-drop[^/]*',
      '@mui/base',
      'framer-motion',
      'motion',
      '@react-spring/[^/]+',
      'react-spring',
      'gsap',
    ].join('|') +
    ')(?:/|$)',
);

/** The reason an import breaks rule 1, or null. `importer` is an absolute path; node_modules may import freely. */
export function layerImportViolation(id, importer) {
  if (!importer || importer.includes('/node_modules/') || id.startsWith('.') || id.startsWith('/'))
    return null;
  if (SECOND.test(id))
    return `"${id}" (from ${importer}) is a second behaviour, drag or motion library; the design system's React Aria layer is the one layer (DESIGN.md).`;
  if (LAYER.test(id) && !importer.includes(LAYER_DIR))
    return `"${id}" (from ${importer}) imports the headless layer outside web/src/ds/behaviour; import the design system's component instead (DESIGN.md).`;
  return null;
}

/** Static import closure of the given chunk file names in a Rollup/Rolldown output bundle. */
function closure(bundle, roots) {
  const seen = new Set();
  const visit = file => {
    if (seen.has(file) || !bundle[file] || bundle[file].type !== 'chunk') return;
    seen.add(file);
    for (const next of bundle[file].imports) visit(next);
  };
  roots.forEach(visit);
  return seen;
}

const isLayerModule = id =>
  id.includes('/node_modules/react-aria') ||
  id.includes('/node_modules/@react-aria/') ||
  id.includes('/node_modules/react-stately') ||
  id.includes('/node_modules/@react-stately/') ||
  id.includes(LAYER_DIR);

/**
 * First paint never carries the layer, and the layer's own chunks fit `maxGzipBytes`.
 * Eager = the HTML entries' chunks plus the immediately loaded app module (src/Hosted.tsx) and their static imports.
 */
export function layerBundleReport(bundle, maxGzipBytes) {
  const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
  const eagerRoots = chunks
    .filter(chunk => chunk.isEntry || chunk.facadeModuleId?.endsWith('/web/src/Hosted.tsx'))
    .map(chunk => chunk.fileName);
  const eager = closure(bundle, eagerRoots);
  const problems = [];
  for (const file of eager) {
    const leaked = Object.keys(bundle[file].modules ?? {}).filter(isLayerModule);
    if (leaked.length)
      problems.push(
        `first-paint chunk ${file} carries the behaviour layer (${leaked.slice(0, 3).join(', ')}); load it with loadLayer() instead.`,
      );
  }
  const entry = chunks.find(chunk => chunk.facadeModuleId?.includes(`${LAYER_DIR}index.`));
  if (!entry) return { problems, layer: null };
  const files = [...closure(bundle, [entry.fileName])].filter(file => !eager.has(file));
  const gzipBytes = files.reduce((sum, file) => sum + gzipSync(bundle[file].code).length, 0);
  if (gzipBytes > maxGzipBytes)
    problems.push(
      `behaviour layer chunks are ${gzipBytes} gzip bytes, over the ${maxGzipBytes} budget (web-ds-layer-gzip in src/speed-budgets.json); did the locale plugin stop removing other languages?`,
    );
  return { problems, layer: { files, gzipBytes } };
}
