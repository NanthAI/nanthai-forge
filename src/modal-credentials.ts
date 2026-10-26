// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { ForgeError } from './errors.js';
import type { ModalCredentialsRef } from './check-runner-settings.js';

const credentials = z.object({ tokenId: z.string().trim().min(1), tokenSecret: z.string().trim().min(1) });
const invalid = () =>
  new ForgeError(
    'MODAL_CREDENTIALS_REQUIRED',
    'Configure checks.credentialsRef with the project’s Modal token environment names or an external JSON secret file containing tokenId and tokenSecret. The owner account is never used implicitly.',
  );
/** Resolve immediately before SDK invocation; return values only in process memory. */
export function modalCredentials(root: string, reference?: ModalCredentialsRef | null, env = process.env) {
  if (!reference) throw invalid();
  try {
    let value: unknown;
    if (reference.kind === 'env') {
      value = { tokenId: env[reference.tokenId], tokenSecret: env[reference.tokenSecret] };
    } else {
      if (!isAbsolute(reference.path)) throw invalid();
      const file = realpathSync(reference.path),
        project = realpathSync(root);
      const inside = relative(project, file);
      if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)))
        throw invalid();
      value = JSON.parse(readFileSync(file, 'utf8'));
    }
    const parsed = credentials.safeParse(value);
    if (!parsed.success) throw invalid();
    return { MODAL_TOKEN_ID: parsed.data.tokenId, MODAL_TOKEN_SECRET: parsed.data.tokenSecret };
  } catch {
    // JSON, filesystem and SDK diagnostics can contain credential bytes or private paths.
    throw invalid();
  }
}
