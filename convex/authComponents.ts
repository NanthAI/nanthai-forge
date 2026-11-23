// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  componentsGeneric,
  type FunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from 'convex/server';
import type { Infer } from 'convex/values';
import type { ComponentApi as Auth } from '@convex-dev/auth/_generated/component.js';
import type { ComponentApi as Github } from '@convex-dev/auth/components/github/_generated/component.js';
import type { ComponentApi as Passkey } from '@convex-dev/auth/components/passkey/_generated/component.js';
import type { ComponentApi as Username } from '@convex-dev/auth/components/username/_generated/component.js';
import type { displayPasskey, firstPasskeyPage, passkeyPosition } from './authPasskeyPage';

// Keep the component contract typed during offline API generation too.
type Components = {
  auth: Auth<'auth'>;
  authGithub: Github<'authGithub'>;
  authPasskey: Passkey<'authPasskey'> & {
    accountPasskeys: {
      first: FunctionReference<
        'query',
        'internal',
        { userId: string },
        Infer<typeof firstPasskeyPage>,
        'authPasskey'
      >;
      more: FunctionReference<
        'query',
        'internal',
        { userId: string; after: Infer<typeof passkeyPosition>; paginationOpts: PaginationOptions },
        PaginationResult<Infer<typeof displayPasskey>>,
        'authPasskey'
      >;
    };
  };
  authUsername: Username<'authUsername'>;
};
const mounted = componentsGeneric() as unknown as Components;
export const authComponents: Components = {
  auth: mounted.auth,
  authGithub: mounted.authGithub,
  authPasskey: mounted.authPasskey,
  authUsername: mounted.authUsername,
};
