// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { WorkStore } from './work-store.js';
import { requireHostedBinding, updateHostState } from './host-binding.js';
import { checkoutHostedMain } from './hosted-main-checkout.js';
import { ConvexExchange } from './exchange-client.js';
import { hostedActionError } from './hosted-action-error.js';
import { rememberSourceAuthorityError } from './source-authority-client.js';
export async function boundMainCheckout(root: string, target?: string) {
  const store = new WorkStore(root),
    binding = requireHostedBinding(store);
  try {
    const client = new ConvexExchange(
      binding.deployment,
      process.env.FORGE_AUTH_TOKEN,
      binding.projectId,
      '',
      null,
    );
    const destination = resolve(target ?? join(dirname(store.root), `${basename(store.root)}-hosted-main`));
    const key = JSON.stringify([binding.deployment, binding.projectId, destination]);
    const operationId = updateHostState(store, state => ((state.pulls ??= {})[key] ??= randomUUID()));
    const result = await checkoutHostedMain(
      destination,
      {
        url: binding.deployment,
        projectId: binding.projectId,
        operationId,
      },
      client,
    );
    updateHostState(store, state => {
      if (state.pulls?.[key] === operationId) delete state.pulls[key];
    });
    return result;
  } catch (error) {
    rememberSourceAuthorityError(store, error, binding.projectId);
    throw hostedActionError(error, 'hosted main checkout');
  }
}
