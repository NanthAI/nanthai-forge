// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
export default async function payload(input) {
  return { bytes: input.text.length, stdinBytes: readFileSync(0).length };
}
