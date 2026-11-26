// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
const instanceLiterals =
  /\b(?:(?:[a-z0-9-]+\.)*forge\.nanthai\.tech|nanthai\/nanthai-forge|nanthai-forge-(?:public-code-)?(?:dev|prod)|forge-probe\.convex\.(?:cloud|site)|benevolent-wildebeest-974)\b/gi;

// Tests and .github operator workflows are outside product source. These are the only
// product-tree exceptions: distribution defaults, official installation, a dev-only
// analytics rollout, and operator and benchmark tools. Keep routing out of them.
const allowed = new Map([
  ['src/forge-site.ts', new Set(['dev.forge.nanthai.tech', 'forge.nanthai.tech'])],
  ['web/src/app/start/agent-apps.ts', new Set(['nanthai/nanthai-forge'])],
  ['web/src/product-analytics.ts', new Set(['dev.forge.nanthai.tech'])],
  ['scripts/build-site.mjs', new Set(['nanthai-forge-dev'])],
  ['scripts/build-public-code-worker.mjs', new Set(['nanthai-forge-public-code-dev'])],
  ['scripts/ui-bot-setup.mjs', new Set(['dev.forge.nanthai.tech', 'benevolent-wildebeest-974'])],
  ['scripts/benchmark-t3code-import.mjs', new Set(['benevolent-wildebeest-974'])],
  ['scripts/phase5-hosted-lifecycle-drill.mjs', new Set(['benevolent-wildebeest-974'])],
  ['convex/deviceRemovalBackfill.ts', new Set(['benevolent-wildebeest-974'])],
  ['convex/projectPlanRollupPreview.ts', new Set(['benevolent-wildebeest-974'])],
  ['convex/projectPlanLaneBackfill.ts', new Set(['benevolent-wildebeest-974'])],
  ['scripts/perf/cli-first-network.mjs', new Set(['forge-probe.convex.cloud'])],
]);
const benchmark = /^scripts\/bench-(?:t3code|zoo)\//;
const productSource = /^(?:src|convex|web\/src|scripts|site)\/.*\.(?:[cm]?[jt]sx?|json|ya?ml|sh)$/;

export function instanceLiteralFindings(path, source) {
  if (!productSource.test(path) || benchmark.test(path) || path === 'scripts/check-instance-literals.mjs')
    return [];
  const permitted = new Set(allowed.get(path));
  return source
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(instanceLiterals)].flatMap(([value]) =>
        permitted.delete(value.toLowerCase())
          ? []
          : [
              `${path}:${index + 1}: use instance configuration instead of a Forge deployment or repository literal`,
            ],
      ),
    );
}
