// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState } from './recovery-state.js';
import { refuseRealUserState } from './test-isolation.js';
import { readClientSettings } from './client-settings.js';

const file = (home: string) => join(home, '.config', 'forge', 'edit-hooks.json');
type Settings = { enabled?: boolean; projects?: Record<string, boolean> };
function read(home: string): Settings {
  return existsSync(file(home)) ? JSON.parse(readFileSync(file(home), 'utf8')) : {};
}
export function editHooksEnabled(project?: string, home = homedir()) {
  const settings = read(home);
  return (
    readClientSettings().firstWriteHooks &&
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
