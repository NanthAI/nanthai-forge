// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Flags for scripts/idle-read.mjs. --item adds the Plan click step: after the opening burst settles, click the
// row link for that Item on the Plan page and report its own window (the Item open) beside the Plan open.
import { parseArgs } from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns parsed options, or throws an Error whose message names the first wrong flag. */
export function idleReadOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      path: { type: 'string' },
      minutes: { type: 'string', default: '30' },
      settle: { type: 'string', default: '30' },
      item: { type: 'string' },
    },
  });
  if (!values.project || !values.path) throw new Error('Supply --project PROJECT_ID and --path HANDLE/SLUG.');
  const minutes = Number(values.minutes);
  const settle = Number(values.settle);
  if (!Number.isFinite(minutes) || minutes < 0)
    throw new Error('--minutes must be a number of minutes, 0 or more.');
  if (!Number.isFinite(settle) || settle <= 0)
    throw new Error('--settle must be a number of seconds above 0.');
  const item = values.item?.toLowerCase();
  if (item !== undefined && !UUID.test(item))
    throw new Error('--item must be the full Item id (a UUID); the Plan row links by full id.');
  if (item && minutes > 0 && minutes < 1) throw new Error('--minutes with --item must be 0 or at least 1.');
  return { project: values.project, path: values.path, minutes, settleMs: settle * 1000, item };
}
