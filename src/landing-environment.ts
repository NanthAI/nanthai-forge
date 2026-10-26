// SPDX-License-Identifier: Apache-2.0
import { closeSync, openSync, readSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash.js';
import { checkEnvironment, changedEnvironmentFields, checkPassthrough } from './check-environment.js';
import type { Check, CheckEnvironment } from './work-types.js';
import { landingPinsSchema, landingRuntimeSchema, type LandingPins } from './landing-environment-schema.js';

export { landingPinsSchema, landingRuntimeSchema, type LandingPins };
let runtime: LandingPins['runtime'] | undefined;
function executableDigest(path: string) {
  const hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(64 * 1024),
    file = openSync(path, 'r');
  try {
    for (;;) {
      const bytes = readSync(file, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(file);
  }
  return hash.digest('hex');
}
/** Identity of this installed controller, independent of the shell that invoked it.
 * Installations are immutable while running; retain the loaded process's identity.
 * Hash executable modules, packaged helpers and declared dependency versions,
 * not declarations, source maps or installation paths. */
export function landingRuntime(): LandingPins['runtime'] {
  if (!runtime) {
    const directory = dirname(fileURLToPath(import.meta.url)),
      root = dirname(directory);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
      files: string[];
      dependencies: Record<string, string>;
    };
    const helpers = manifest.files
      .filter(path => path.startsWith('scripts/') && /\.(?:mjs|py)$/.test(path))
      .sort()
      .map(path => [path, digest(readFileSync(join(root, path)))]);
    runtime = {
      nodeExecutable: realpathSync(process.execPath),
      nodeBinary: executableDigest(process.execPath),
      cli: digest(
        JSON.stringify({
          modules: readdirSync(directory)
            .filter(name => name.endsWith('.js'))
            .sort()
            .map(name => [name, digest(readFileSync(join(directory, name)))]),
          helpers,
          version: manifest.version,
          dependencies: Object.entries(manifest.dependencies).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        }),
      ),
    };
  }
  return { ...runtime };
}
export const landingPins = (): LandingPins => ({
  environment: checkEnvironment(),
  runtime: landingRuntime(),
});
export function changedLandingRuntime(before: LandingPins['runtime'], after = landingRuntime()) {
  return (['nodeExecutable', 'nodeBinary', 'cli'] as const).filter(
    name => (name !== 'nodeBinary' || before.nodeBinary !== undefined) && before[name] !== after[name],
  );
}
/** The owner supplies shell defaults; an explicit check declaration opts a name
 * back into submission compatibility. Exact run fingerprints remain unchanged. */
export function changedLandingEnvironment(before: CheckEnvironment, after: CheckEnvironment, check?: Check) {
  const declared = new Set(check ? checkPassthrough(check) : []);
  return changedEnvironmentFields(before, after).filter(
    name => declared.has(name) || !/^(?:PATH|TERM|LANG|TZ|LC_[A-Z_]+)$/.test(name),
  );
}
export const landingPinsChanged = (fields: string[]) =>
  `Queued landing pins changed: ${fields.join(', ')}. Configure the owner service and submitter with compatible Node runtime and check settings, then submit a new finish/land operation.`;
