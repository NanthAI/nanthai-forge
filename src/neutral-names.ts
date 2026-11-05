// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';

/** Names shown to the owner, collaborators and agents never come from the machine's hostname or OS
 * user (owner rule: people and machines appear only as a Forge handle or public login). Defaults
 * are neutral labels the owner can replace. */
export const neutralDeviceName = () => `device-${randomBytes(2).toString('hex')}`;

/** Stable per root and project, so a reconnecting runner keeps its label without using the hostname. */
export const neutralRunnerName = (...parts: string[]) =>
  `runner-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 4)}`;

/** Lane setup label when FORGE_MACHINE is unset. */
export const NEUTRAL_MACHINE = 'local';
