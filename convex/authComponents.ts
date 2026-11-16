// SPDX-License-Identifier: Apache-2.0
import { componentsGeneric } from 'convex/server';
import type { ComponentApi as Auth } from '@convex-dev/auth/_generated/component.js';
import type { ComponentApi as Github } from '@convex-dev/auth/components/github/_generated/component.js';
import type { ComponentApi as Passkey } from '@convex-dev/auth/components/passkey/_generated/component.js';
import type { ComponentApi as Username } from '@convex-dev/auth/components/username/_generated/component.js';

// Keep the component contract typed during offline API generation too.
type Components = {
  auth: Auth<'auth'>;
  authGithub: Github<'authGithub'>;
  authPasskey: Passkey<'authPasskey'>;
  authUsername: Username<'authUsername'>;
};
const mounted = componentsGeneric() as unknown as Components;
export const authComponents: Components = {
  auth: mounted.auth,
  authGithub: mounted.authGithub,
  authPasskey: mounted.authPasskey,
  authUsername: mounted.authUsername,
};
