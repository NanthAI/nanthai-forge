// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState } from './recovery-state.js';
import { refuseRealUserState } from './test-isolation.js';
import { clientSettingsFile } from './client-settings-path.js';
import { ForgeError } from './errors.js';

const file = (home: string) => join(home, '.config', 'forge', 'edit-hooks.json');
type Settings = { enabled?: boolean; projects?: Record<string, boolean> };
function read(home: string): Settings {
  return existsSync(file(home)) ? JSON.parse(readFileSync(file(home), 'utf8')) : {};
}
/** The `firstWriteHooks` client setting (default on) without the settings schema, which pulls the
 * whole record-schema library into every hook process (381c62df). A file that is not an object, or
 * whose flag is not a boolean, is refused as the full reader would refuse it. */
function firstWriteHooksSetting() {
  let text: string;
  try {
    text = readFileSync(clientSettingsFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const flag = (value as { firstWriteHooks?: unknown } | null)?.firstWriteHooks;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (flag !== undefined && typeof flag !== 'boolean')
  )
    throw new ForgeError('CLIENT_SETTINGS_INVALID', `Fix or delete ${clientSettingsFile()}.`);
  return flag ?? true;
}
export function editHooksEnabled(project?: string, home = homedir()) {
  const settings = read(home);
  return (
    firstWriteHooksSetting() &&
    settings.enabled !== false &&
    (!project || settings.projects?.[project] !== false)
  );
}
export function setEditHooksEnabled(enabled: boolean, project?: string, home = homedir()) {
  refuseRealUserState(file(home), 'Forge hook settings');
  const settings = read(home);
  if (project) (settings.projects ??= {})[project] = enabled;
  else settings.enabled = enabled;
  mkdirBelow(home, join(home, '.config', 'forge'));
  if (!existsSync(file(home)) || JSON.stringify(read(home)) !== JSON.stringify(settings))
    writeRecoveryState(file(home), settings);
}
