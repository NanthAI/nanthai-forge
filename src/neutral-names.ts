// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';

/** Names shown to the owner, collaborators and agents never come from the machine's hostname or OS
 * user (owner rule: people and machines appear only as a Forge handle or public login). Defaults
 * are neutral labels the owner can replace. */
export const neutralDeviceName = () => `device-${randomBytes(2).toString('hex')}`;
