// SPDX-License-Identifier: Apache-2.0
// Public identity rule (Issue 9a19b304): nothing an agent or a reader is shown carries a raw account id.
// Clerk account ids are `user_` plus a long alphanumeric tail; this scan covers every string in a value,
// including text embedded in nudges, notices, receipts and JSON strings.
export const accountIdShape = /\b(?:user|org)_[A-Za-z0-9]{8,}/;

/** Names the path of every string in `value` that contains a raw account id. */
export function accountIdLeaks(value, path = '$', found = []) {
  if (typeof value === 'string') {
    if (accountIdShape.test(value)) found.push(path);
  } else if (Array.isArray(value)) value.forEach((item, i) => accountIdLeaks(item, `${path}[${i}]`, found));
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) accountIdLeaks(item, `${path}.${key}`, found);
  return found;
}

export function assertNoAccountIds(assert, value, label) {
  assert.deepEqual(accountIdLeaks(value), [], `${label}: raw account id in agent-facing output`);
}
