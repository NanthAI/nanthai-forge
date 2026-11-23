// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One provider's review call for scripts/review-api.mjs (Item f082efd6): key, spend reservation, POST,
// settle, parse, and one retry. Which errors send the review to the other provider is decided here.
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  KEYCHAIN,
  ReviewError,
  buildRequest,
  costUsd,
  parseFindings,
  readReply,
  redact,
} from './review-api-lib.mjs';

/** Failures that hand the review to the other provider (a pinned provider still just fails). */
export const SPILL_CODES = new Set([
  'REVIEW_NO_KEY',
  'REVIEW_NETWORK',
  'REVIEW_HTTP',
  'REVIEW_UNPARSEABLE',
  'REVIEW_TRUNCATED',
  'REVIEW_REFUSED',
]);

/** Short reason for the "Routed to … because …" line; never the provider's body text. */
export const failureReason = error => {
  const base =
    error.code === 'REVIEW_NO_KEY'
      ? 'no key'
      : error.code === 'REVIEW_NETWORK'
        ? 'timeout or network error'
        : error.code === 'REVIEW_HTTP'
          ? `HTTP ${error.status}`
          : error.code === 'REVIEW_REFUSED'
            ? 'refused the review'
            : error.code === 'REVIEW_TRUNCATED'
              ? 'reply cut off'
              : 'unusable reply';
  return `${base}${error.retried ? ' after one retry' : error.noRoom ? ', no room under the caps to retry' : ''}`;
};

// One retry for 429, 5xx, a timeout or network error, and the GPT text that is not the JSON object.
const retryable = (error, provider) =>
  error.code === 'REVIEW_NETWORK' ||
  (error.code === 'REVIEW_HTTP' && (error.status === 429 || error.status >= 500)) ||
  (error.code === 'REVIEW_UNPARSEABLE' && provider === 'openai');

/**
 * Review through one provider. The retry reserves no more than the first call's worst case and only
 * while `roomToRetry()` (the caps) still allows it; with no room the first error stands.
 */
export async function callProvider({
  deps,
  args,
  input,
  route,
  tier,
  price,
  estimate,
  system,
  user,
  maxOutputTokens,
  roomToRetry,
  schema,
  schemaName,
  parse = parseFindings,
  purpose,
}) {
  const { provider, model } = route;
  const request = buildRequest(provider, {
    model,
    system,
    user,
    maxOutputTokens,
    effort: args.effort ?? 'high',
    schema,
    schemaName,
  });
  const key = deps.readKey(KEYCHAIN[provider]);
  if (!key)
    throw new ReviewError(
      'REVIEW_NO_KEY',
      `No ${provider} key in the keychain (service ${KEYCHAIN[provider]}, account forge). Ask the lead to add it; nothing was sent.`,
    );
  const headers = { ...request.headers, [request.keyHeader]: `${request.keyPrefix ?? ''}${key}` };
  // One attempt: reserve the worst case first so concurrent builders see it; the call row settles it. A
  // failure whose billing is unknown (timeout, network, 5xx, unreadable body) settles at the reservation.
  const attempt = async () => {
    const id = randomUUID();
    const append = row => {
      mkdirSync(dirname(deps.spendLog), { recursive: true });
      appendFileSync(
        deps.spendLog,
        `${JSON.stringify({
          id,
          time: deps.now().toISOString(),
          lane: input.laneId,
          item: args.item ?? null,
          provider,
          model,
          tier,
          ...(purpose ? { purpose } : {}),
          ...row,
        })}\n`,
      );
    };
    append({ kind: 'reserve', usd: Number(estimate.toFixed(6)) });
    const unknownBilling = () => append({ kind: 'call', usd: Number(estimate.toFixed(6)), estimated: true });
    let raw;
    let response;
    try {
      response = await deps.request(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
      });
      raw = await response.text();
    } catch (error) {
      unknownBilling();
      throw new ReviewError('REVIEW_NETWORK', redact(`Request failed: ${error?.name ?? 'error'}.`, [key]));
    }
    if (!response.ok) {
      if (response.status >= 500) unknownBilling();
      else append({ kind: 'call', usd: 0 }); // a 4xx was rejected before any generation
      const failure = new ReviewError(
        'REVIEW_HTTP',
        `${provider} returned ${response.status}: ${redact(raw, [key]).slice(0, 400)}`,
      );
      failure.status = response.status;
      throw failure;
    }
    const settle = usage => {
      const usd = costUsd(price, usage);
      append({
        kind: 'call',
        inputTokens: usage.input,
        cachedTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output,
        usd: Number(usd.toFixed(6)),
      });
      return usd;
    };
    let reply;
    try {
      reply = readReply(provider, JSON.parse(raw));
    } catch (error) {
      if (error.usage) settle(error.usage); // a refused or truncated call is still billed
      else unknownBilling();
      if (error instanceof ReviewError) throw error;
      throw new ReviewError('REVIEW_UNPARSEABLE', 'The provider reply body was not JSON.');
    }
    return { text: reply.text, usage: reply.usage, usd: settle(reply.usage) };
  };

  let usd = 0;
  for (let retried = false; ; retried = true) {
    try {
      const result = await attempt();
      usd += result.usd; // billed even when the text then fails to parse
      // The model's text can echo the key; findings and parse diagnostics never carry it.
      return { usage: result.usage, usd, parsed: parse(redact(result.text, [key])) };
    } catch (error) {
      if (error instanceof Error) error.message = redact(error.message, [key]);
      if (retried) error.retried = true;
      if (retried || !retryable(error, provider)) throw error;
      // Wait first, then check the caps, so another builder's reservation during the pause counts.
      if (error.code !== 'REVIEW_UNPARSEABLE') await deps.backoff(2_000);
      try {
        roomToRetry();
      } catch {
        error.noRoom = true;
        error.message += ' No room under the caps to retry.';
        throw error;
      }
    }
  }
}
