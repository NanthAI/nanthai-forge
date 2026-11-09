// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { randomUUID } from 'node:crypto';
import { ConvexExchange } from './exchange-client.js';
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import { checkoutHostedMain } from './hosted-main-checkout.js';
import { hostedMainV2Schema, type HostedMain } from './hosted-main.js';
import { resolveAuthToken } from './auth-store.js';
import { deadlineConvexClient } from './network-convex-client.js';
import { exchangeConvexFetch } from './exchange-convex-fetch.js';
import { invariant } from './errors.js';
import { parseHostedResponse } from './hosted-response.js';
import { cliReleaseSignaturesSchema, type CliReleaseSignature } from './cli-release-signature.js';
export type CliSource = { url: string; projectId: string };
export function cliReleaseSource(address: CliSource) {
  const token = resolveAuthToken(address.url);
  invariant(token, 'AUTH_REQUIRED', 'Run nforge login before checking the CLI release.');
  const client = deadlineConvexClient(address.url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: exchangeConvexFetch({ retries: 0 }),
  });
  client.setAuth(token);
  const current = async () => {
    const raw = await client.query(makeFunctionReference<'query'>('projectHostedChannels:current'), {
      projectId: address.projectId,
    });
    const selected = hostedMainV2Schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    invariant(
      selected.projectId === address.projectId,
      'PROJECT_UNAVAILABLE',
      'Read the configured CLI release project.',
    );
    return selected;
  };
  /** One small read per attempted update: this State's stored release signatures (unverified). */
  const signatures = async (head: string) => {
    const raw = await client.query(makeFunctionReference<'query'>('projectReleaseSignatures:forState'), {
      projectId: address.projectId,
      head,
    });
    const parsed = parseHostedResponse(
      cliReleaseSignaturesSchema,
      typeof raw === 'string' ? JSON.parse(raw) : raw,
    );
    invariant(parsed.head === head, 'HOSTED_PROTOCOL_INVALID', 'Release signatures name another State.');
    return parsed.signatures;
  };
  /** Owner only: store one signature for a State (the server keeps it; the CLI verifies it). */
  const publishSignature = async (head: string, signed: CliReleaseSignature) => {
    const raw = await client.mutation(makeFunctionReference<'mutation'>('projectReleaseSignatures:put'), {
      projectId: address.projectId,
      head,
      ...signed,
    });
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as { stored: boolean };
  };
  return {
    current,
    signatures,
    publishSignature,
    async checkout(root: string, selected: HostedMain) {
      const downloads = new HostedCheckoutDownloads(
        new ConvexExchange(address.url, undefined, address.projectId, '', null),
      );
      let first = true;
      return checkoutHostedMain(
        root,
        {
          ...address,
          operationId: randomUUID(),
          expected: { head: selected.head, receiptId: selected.receipt.id },
        },
        {
          current: async () => {
            if (first) {
              first = false;
              return selected;
            }
            return current();
          },
          ...downloads.transport(),
        },
      );
    },
  };
}
