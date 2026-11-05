// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { z } from 'zod';
import { readSource } from './files.js';
import { hostedMainSchema } from './hosted-main.js';
import { parseNativeStateValue } from './native-state-format.js';
export const hostedMainMarkerSchema = z.object({ selection: hostedMainSchema, state: z.unknown() }).strict();
export function readHostedMainMarker(root: string) {
  const bytes = readSource(root, join('.forge', 'hosted-main.json'), Number.MAX_SAFE_INTEGER);
  if (!bytes) return null;
  const marker = hostedMainMarkerSchema.parse(JSON.parse(bytes.toString()));
  return { ...marker, state: parseNativeStateValue(marker.state) };
}

/** Selection-only reads avoid cloning a large manifest for address/status routing. */
export function readHostedMainSelection(root: string) {
  const bytes = readSource(root, join('.forge', 'hosted-main.json'), Number.MAX_SAFE_INTEGER);
  return bytes ? hostedMainSchema.parse(JSON.parse(bytes.toString()).selection) : null;
}
