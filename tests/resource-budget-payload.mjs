// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readFileSync } from 'node:fs';
export default async function payload(input) {
  return { bytes: input.text.length, stdinBytes: readFileSync(0).length };
}
