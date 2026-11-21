// SPDX-License-Identifier: Apache-2.0
import batchWorker from '@convex-dev/batch-worker/convex.config.js';
import { defineComponent } from 'convex/server';

// Keep the upstream mount and function paths. Only the account listing is local.
const component = defineComponent('authPasskey');
component.use(batchWorker);
export default component;
