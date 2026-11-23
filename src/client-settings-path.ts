// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the machine-local client settings live. Apart from the settings schema so the edit and
 * turn-end hooks, which run on every edit and stop, need not load it to read one flag. */
export function forgeConfigDirectory() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge');
}
export function clientSettingsFile() {
  return process.env.FORGE_CLIENT_SETTINGS || join(forgeConfigDirectory(), 'client.json');
}
