// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// P7 billing actions: the typed contract P8 connects (Item 5822dd13). Each action carries an operation id and is
// retry-safe by it. The stub keeps results in memory only: no provider, network, timers, storage, charge or email.
import type { LimitChoice } from './preview';
import type { PlanId } from './contract';

/** A hosted payment page takes the card; Forge never holds card fields or card secrets. */
export type CheckoutState = 'handoff' | 'confirm' | 'declined' | 'unknown' | 'paid';
export type Checkout = {
  operationId: string;
  to: PlanId;
  state: CheckoutState;
  /** Attempts sent to the provider for this operation; reconciling never adds one. */
  attempts: number;
  /** Null in P7: no hosted page exists. P8 returns the provider's one-time page address. */
  handoffUrl: null;
};
export type BillingDetails = {
  billedTo: string;
  country: string;
  postcode: string;
  address: string;
  taxId: string;
  copyTo: string;
};
export type ActionResult<F extends string = never> =
  | { ok: true; operationId: string }
  | { ok: false; operationId: string; error: 'provider-unavailable' | 'invalid'; field?: F; message: string };
export type CorrectionField = 'billedTo' | 'address' | 'taxId' | 'other';
export type CorrectionRequest = {
  operationId: string;
  invoiceId: string;
  field: CorrectionField;
  text: string;
};
/** Download action contract: P8 returns a short-lived address; P7 has no file to give. */
export type InvoiceDownload = { status: 'unavailable'; reason: 'sample' | 'provider-unavailable' };

export interface BillingActions {
  /** Starts or returns the checkout for this operation id; a repeated id never starts a second attempt. */
  checkout(request: { operationId: string; to: PlanId }): Checkout;
  /** Reads the same operation's outcome; never charges. */
  reconcile(operationId: string): Checkout | null;
  replaceCard(request: { operationId: string }): Checkout;
  /** A move down waits for the period end; no payment. Undo before then changes nothing. */
  schedulePlan(request: { operationId: string; to: PlanId }): ActionResult;
  setLimit(request: { operationId: string; blocks: LimitChoice }): ActionResult;
  saveDetails(request: { operationId: string; details: BillingDetails }): ActionResult<keyof BillingDetails>;
  requestCorrection(request: CorrectionRequest): ActionResult<CorrectionField>;
  download(invoiceId: string): InvoiceDownload;
}

/** Sample outcomes the hosted page would report, chosen by the preview, never by a provider. */
export type StubScript = {
  checkout?: CheckoutState;
  /** The first correction request for each operation fails as if the provider were unreachable. */
  correctionFailsOnce?: boolean;
  providerDown?: boolean;
};
const taxId = /^[A-Z]{2}[0-9A-Z]{8,12}$/;
export function createBillingActions(script: StubScript = {}) {
  const checkouts = new Map<string, Checkout>();
  const corrections = new Set<string>();
  const begin = (operationId: string, to: PlanId): Checkout => {
    const known = checkouts.get(operationId);
    if (known) return known;
    const made: Checkout = {
      operationId,
      to,
      state: script.checkout ?? 'handoff',
      attempts: 1,
      handoffUrl: null,
    };
    checkouts.set(operationId, made);
    return made;
  };
  const actions: BillingActions & {
    /** Preview only: what the hosted page reports back for an operation. */
    settle(operationId: string, state: CheckoutState): Checkout | null;
  } = {
    checkout: ({ operationId, to }) => begin(operationId, to),
    replaceCard: ({ operationId }) => begin(operationId, 'pro'),
    reconcile: operationId => checkouts.get(operationId) ?? null,
    settle(operationId, state) {
      const known = checkouts.get(operationId);
      if (!known) return null;
      const next = { ...known, state };
      checkouts.set(operationId, next);
      return next;
    },
    schedulePlan: ({ operationId }) => ({ ok: true, operationId }),
    setLimit: ({ operationId }) =>
      script.providerDown
        ? { ok: false, operationId, error: 'provider-unavailable', message: 'The limit was not changed.' }
        : { ok: true, operationId },
    saveDetails({ operationId, details }) {
      const id = details.taxId.replace(/\s/g, '').toUpperCase();
      if (id && !taxId.test(id))
        return {
          ok: false,
          operationId,
          error: 'invalid',
          field: 'taxId',
          message: `${id} is not a tax ID in the expected form: two letters, then 8 to 12 letters or digits. Nothing was saved.`,
        };
      if (!details.billedTo.trim())
        return {
          ok: false,
          operationId,
          error: 'invalid',
          field: 'billedTo',
          message: 'Add the name to bill.',
        };
      return { ok: true, operationId };
    },
    requestCorrection({ operationId, text }) {
      if (!text.trim())
        return {
          ok: false,
          operationId,
          error: 'invalid',
          field: 'other',
          message: 'Say what should change.',
        };
      if (script.correctionFailsOnce && !corrections.has(operationId)) {
        corrections.add(operationId);
        return {
          ok: false,
          operationId,
          error: 'provider-unavailable',
          message: 'The request did not reach billing. What you typed is kept; send it again.',
        };
      }
      return { ok: true, operationId };
    },
    download: () => ({
      status: 'unavailable',
      reason: script.providerDown ? 'provider-unavailable' : 'sample',
    }),
  };
  return actions;
}
export type StubActions = ReturnType<typeof createBillingActions>;
/** One fresh id per user action; a retry of the same action reuses it. */
export const operationId = () => crypto.randomUUID();
