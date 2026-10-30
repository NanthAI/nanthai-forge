// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { invariant } from './errors.js';
import { ConvexExchange } from './exchange-client.js';
import { metricAddress } from './self-metrics-source.js';
import { billOperationId, billProviders, hostedBillSchema, type HostedBill } from './self-metrics-bills.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';

export const recordBillHelp =
  'nforge metrics record-bill ROOT --provider convex|github-actions|r2|netlify|blacksmith|modal --from DATE --to DATE --billed-usd N [--list-usd N] [--usage unit=qty,...] [--rate unit=usd,...] [--basis TEXT]\nOwner only. Enter the provider invoice or dashboard amount; Forge never fetches bills. Identical input reconciles; a corrected bill for the same provider and period start replaces the earlier one in reports.\n';
const flags = ['--provider', '--from', '--to', '--billed-usd', '--list-usd', '--usage', '--rate', '--basis'];
function amount(flag: string, value: string) {
  const n = Number(value);
  invariant(
    value.trim() !== '' && Number.isFinite(n) && n >= 0,
    'BAD_ARGUMENT',
    `${flag} needs a number >= 0.`,
  );
  return n;
}
function pairs(flag: string, value: string | undefined) {
  const result: Record<string, number> = {};
  for (const item of value ? value.split(',') : []) {
    const [key, quantity, extra] = item.split('=');
    invariant(
      key && quantity !== undefined && extra === undefined,
      'BAD_ARGUMENT',
      `${flag} uses unit=number.`,
    );
    invariant(!(key in result), 'BAD_ARGUMENT', `${flag} repeats ${key}.`);
    result[key] = amount(flag, quantity);
  }
  return result;
}
function instant(flag: string, value: string) {
  const at = Date.parse(value);
  invariant(Number.isFinite(at), 'BAD_ARGUMENT', `${flag} needs a date.`);
  return new Date(at).toISOString();
}
/** Parse only; no network. Exported for tests. */
export function parseRecordBill(args: string[]): { root: string; bill: HostedBill } {
  const [root, ...rest] = args;
  invariant(root && !root.startsWith('--'), 'BAD_ARGUMENT', 'record-bill requires ROOT.');
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!,
      value = rest[++i];
    invariant(
      flags.includes(flag) && !(flag in options),
      'BAD_ARGUMENT',
      'Unknown or repeated record-bill option.',
    );
    invariant(value !== undefined && !value.startsWith('--'), 'BAD_ARGUMENT', `${flag} requires a value.`);
    options[flag] = value;
  }
  const provider = options['--provider'] === 'actions' ? 'github-actions' : options['--provider'];
  invariant(
    billProviders.includes(provider as (typeof billProviders)[number]),
    'BAD_ARGUMENT',
    `--provider is one of ${billProviders.join(', ')}.`,
  );
  invariant(options['--from'] && options['--to'] && options['--billed-usd'], 'BAD_ARGUMENT', recordBillHelp);
  const body = {
    provider: provider as HostedBill['provider'],
    periodFrom: instant('--from', options['--from']),
    periodTo: instant('--to', options['--to']),
    billedUsd: amount('--billed-usd', options['--billed-usd']),
    listUsd: options['--list-usd'] === undefined ? null : amount('--list-usd', options['--list-usd']),
    usage: pairs('--usage', options['--usage']),
    rates: pairs('--rate', options['--rate']),
    basis: options['--basis'] ?? 'Owner-entered provider bill.',
  };
  return { root, bill: hostedBillSchema.parse({ ...body, operationId: billOperationId(body) }) };
}
export async function recordBillCli(
  args: string[],
  send?: (address: HostedAgentAddress, bill: HostedBill) => Promise<unknown>,
) {
  if (!args.length || args[0] === '--help') {
    process.stdout.write(recordBillHelp);
    return;
  }
  const { root, bill } = parseRecordBill(args);
  const { address } = metricAddress(root);
  invariant(address, 'BAD_ARGUMENT', 'record-bill needs a hosted project ROOT.');
  const raw = await (
    send ??
    ((target, value) =>
      new ConvexExchange(
        target.url,
        process.env.FORGE_AUTH_TOKEN,
        target.projectId,
        '',
        null,
      ).client.mutation(makeFunctionReference<'mutation'>('projectSelfMetricBills:record'), {
        projectId: target.projectId,
        bill: JSON.stringify(value),
      }))
  )(address, bill);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
