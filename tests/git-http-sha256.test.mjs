// SPDX-License-Identifier: Apache-2.0
import { registerCloneTests } from './helpers/git-http-clone.mjs';
import { registerPushTests } from './helpers/git-http-push.mjs';
registerCloneTests('sha256');
registerPushTests('sha256');
