// SPDX-License-Identifier: Apache-2.0
// CLI envelopes are evidence of executed actions; nested advice and printed commands are not.
export function cliReplies(text) {
  return String(text ?? '')
    .split('\n')
    .flatMap(line => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

export function operationsOf(stdout, stderr = '', executedAction = null) {
  const canonical = action => ({ land: 'finish', checkpoint: 'save' })[action] ?? action;
  const operations = new Map();
  for (const reply of [...cliReplies(stdout), ...cliReplies(stderr)]) {
    if (typeof reply.action !== 'string' || !reply.result) continue;
    // Raw source returned by show can itself contain JSON; it is not a CLI action result.
    if (executedAction && canonical(reply.action) !== canonical(executedAction)) continue;
    const operationId = reply.operationId ?? reply.resolved?.operationId ?? null;
    const receiptId =
      reply.receiptId ??
      reply.result.submission?.acceptance?.receiptId ??
      reply.result.acceptance?.receiptId ??
      null;
    if (typeof operationId !== 'string' && typeof receiptId !== 'string') continue;
    const operation = { action: reply.action, operationId, receiptId };
    operations.set(JSON.stringify([reply.action, operationId ?? receiptId]), operation);
  }
  return [...operations.values()];
}

/** Nonzero CLI exits print structured errors on stderr, often after stdout progress. */
export function cliError(error) {
  for (const stream of [error.stderr, error.stdout]) {
    const failure = cliReplies(stream).findLast(reply => reply.error?.code)?.error;
    if (failure) return { code: failure.code, message: failure.message ?? '' };
  }
  return {
    code: typeof error.code === 'string' ? error.code : 'ERROR',
    message: String(error.message ?? ''),
  };
}
