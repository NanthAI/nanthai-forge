// SPDX-License-Identifier: Apache-2.0
/** A project's Forge settings for preflight, for any language. A root `forge.json` holds them:
 * `{"preflight": {"tests": {…}, "static": […], "guards": […]}}`. The same `preflight` object under
 * `forge` in package.json is the fallback, so Node projects keep working unchanged. Each key is read
 * from one file: declaring it in both is an error, never a silent pick. Unknown keys are ignored, so
 * later settings can join the file. Reading never runs repository code. */
export const FORGE_CONFIG_FILE = 'forge.json';
export type PreflightKey = 'tests' | 'static' | 'guards' | 'wrappers';
export type DeclaredPreflight = {
  value: unknown;
  /** The file that declares it. */
  from: 'forge.json' | 'package.json';
  /** How messages name the setting: `forge.json preflight.static` or `forge.preflight.static`. */
  label: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const preflightOf = (value: unknown) =>
  record(value) && record(value.preflight) ? value.preflight : undefined;

/** forge.json text as an object; absent text is undefined. A typo must not silently drop settings,
 * so text that is not a JSON object throws. */
export function parseForgeJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('forge.json is not JSON');
  }
  if (!record(parsed)) throw new Error('forge.json must hold a JSON object');
  return parsed;
}

/** `install.scripts` in forge.json: `true` asks for dependency install scripts when a Lane opens.
 * It is a request the start receipt shows; scripts run only when start passes `installScripts:true`
 * or this machine's installScripts setting accepts it. Any other value, or a malformed file,
 * declares nothing. */
export function declaredInstallScripts(forgeJson: string | undefined): boolean {
  try {
    const install = parseForgeJson(forgeJson)?.install;
    return record(install) && install.scripts === true;
  } catch {
    return false;
  }
}

/** One declared preflight setting and where it was found: forge.json first, then package.json
 * `forge`. Unparseable package.json declares nothing (it is not Forge's file); a malformed forge.json
 * or a key declared in both throws. */
export function declaredPreflight(
  key: PreflightKey,
  packageJson: string | undefined,
  forgeJson: string | undefined,
): DeclaredPreflight | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson ?? '');
  } catch {
    /* No usable package.json. */
  }
  const fromPackage = record(manifest) ? preflightOf(manifest.forge)?.[key] : undefined;
  const fromForge = preflightOf(parseForgeJson(forgeJson))?.[key];
  if (fromPackage !== undefined && fromForge !== undefined)
    throw new Error(`preflight.${key} is declared in both forge.json and package.json; keep one`);
  if (fromForge !== undefined)
    return { value: fromForge, from: 'forge.json', label: `forge.json preflight.${key}` };
  if (fromPackage !== undefined)
    return { value: fromPackage, from: 'package.json', label: `forge.preflight.${key}` };
  return undefined;
}
