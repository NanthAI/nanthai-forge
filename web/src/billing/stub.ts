// SPDX-License-Identifier: Apache-2.0
// Synthetic P7 data, never account data or a payment provider response.
import {
  billingPageSize,
  extraBlock,
  plans,
  type BillingAdapter,
  type BillingInvoice,
  type BillingPage,
  type BillingProject,
  type BillingSnapshot,
  type BillingState,
  type PlanId,
} from './contract';
export type BillingSample = 'hobby' | 'pro' | 'team' | 'over' | 'late' | 'first' | 'worst';
export type BillingView = 'owner' | 'member' | 'loading' | 'error';
const samples: readonly string[] = ['hobby', 'pro', 'team', 'over', 'late', 'first', 'worst'];
export function billingSample(value: string | null): BillingSample {
  return samples.includes(value ?? '') ? (value as BillingSample) : 'first';
}
function page<T>(rows: readonly T[], size: number, cursor = '0'): BillingPage<T> {
  const offset = /^\d+$/.test(cursor) ? Number(cursor) : 0;
  return {
    rows: rows.slice(offset, offset + size),
    total: rows.length,
    nextCursor: offset + size < rows.length ? String(offset + size) : null,
  };
}
export function createBillingStub(
  sample: BillingSample = 'first',
  view: BillingView = 'owner',
): BillingAdapter {
  const plan: PlanId =
    sample === 'hobby' || sample === 'first' ? 'hobby' : sample === 'team' ? 'team' : 'pro';
  const used = { first: 0, hobby: 278, pro: 746, team: 3480, over: 1654, late: 746, worst: 12480 }[sample];
  const names =
    sample === 'worst'
      ? [
          'A very long project name covering the entire release and integration workspace',
          'ストリームの検証',
          'مشروع الاختبار',
          'x',
          'Release tooling',
          'Documentation',
          'API',
          'Web',
          'Mobile',
          'Fixtures',
        ]
      : ['Stream tools', 'Parser', 'Docs'];
  const projects: BillingProject[] = used
    ? names.map((name, i) => ({
        id: `sample-${i}`,
        name,
        href: '/-/account',
        landings:
          i === 0
            ? used - Math.floor(used / names.length) * (names.length - 1)
            : Math.floor(used / names.length),
        lastLanding: i ? '14 November' : '15 November',
      }))
    : [];
  const invoice = (index: number): BillingInvoice => ({
    id: `SAMPLE-${String(index).padStart(4, '0')}`,
    issued: '1 November',
    period: 'October',
    state: sample === 'late' && index === 4 ? 'unpaid' : 'paid',
    lines: [
      { label: `${plans[plan].name}, monthly subscription`, quantity: 1, unitUsd: plans[plan].monthlyUsd },
    ],
    taxUsd: 0,
  });
  const invoices =
    plan === 'hobby'
      ? []
      : Array.from({ length: sample === 'worst' ? 30 : 4 }, (_, i) =>
          invoice((sample === 'worst' ? 30 : 4) - i),
        );
  const snapshot: BillingSnapshot = {
    source: 'stub',
    view: view === 'member' ? 'member' : 'owner',
    pool: {
      owner: {
        kind: 'person',
        handle:
          sample === 'worst'
            ? '@sample-owner-with-a-long-handle-for-responsive-layout-review'
            : '@sample-owner',
      },
      plan,
      period: { start: '2026-11-01T00:00:00Z', resetAt: '2026-12-01T00:00:00Z', label: 'November' },
      acceptedLandings: used,
      extraBlocksAllowed: plan === 'hobby' ? 0 : 2,
      projectedLandings: used ? used * 2 : null,
    },
    projects: page(projects, billingPageSize.projects),
    months:
      sample === 'first'
        ? []
        : (
            [
              ['June', 410],
              ['July', 590],
              ['August', 680],
              ['September', 720],
              ['October', 630],
            ] as const
          ).map(([month, landings]) => ({ month, landings, plan })),
    payment:
      view === 'member' || plan === 'hobby'
        ? null
        : {
            brand: 'Sample card',
            last4: '0000',
            expires: '08/28',
            declined: sample === 'late',
            billedTo: 'Example organisation',
            country: 'Not reported',
            taxLabel: 'Sample, no tax applied',
          },
    invoices: view === 'member' ? null : page(invoices, billingPageSize.invoices),
    nextInvoice:
      view === 'member' || plan === 'hobby'
        ? null
        : {
            ...invoice(5),
            issued: '1 December',
            period: 'November',
            state: 'unpaid',
            lines: [
              ...invoice(5).lines,
              {
                label: `Extra blocks of ${extraBlock.landings} landings`,
                quantity: Math.ceil(Math.max(0, used - plans[plan].includedLandings) / extraBlock.landings),
                unitUsd: extraBlock.usd,
              },
            ],
          },
  };
  const state: BillingState =
    view === 'loading'
      ? { status: 'loading' }
      : view === 'error'
        ? {
            status: 'error',
            message: 'Could not refresh the billing sample. The last snapshot is shown.',
            previous: snapshot,
          }
        : { status: 'ready', snapshot };
  return {
    read: () => state,
    projects: cursor => page(projects, billingPageSize.projects, cursor),
    invoices: cursor => page(view === 'member' ? [] : invoices, billingPageSize.invoices, cursor),
  };
}
