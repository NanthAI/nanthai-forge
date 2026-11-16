// SPDX-License-Identifier: Apache-2.0
import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import auth from '@convex-dev/auth/convex.config.js';
import github from '@convex-dev/auth/components/github/convex.config.js';
import passkey from '@convex-dev/auth/components/passkey/convex.config.js';
import username from '@convex-dev/auth/components/username/convex.config.js';

const app = defineApp({
  env: {
    AUTH_GITHUB_CLIENT_ID: v.string(),
    AUTH_GITHUB_CLIENT_SECRET: v.string(),
  },
});
app.use(auth);
app.use(github, {
  httpPrefix: '/oauth/github',
  env: { CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID, CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET },
});
app.use(passkey);
app.use(username);
export default app;
