// SPDX-License-Identifier: Apache-2.0
import { checkGithubSignIn } from '../dist/github-access.js';
import { ForgeError } from '../dist/errors.js';

// Explicit operator diagnostic: selected deployment settings arrive through a private env file.
try {
  await checkGithubSignIn(process.env.FORGE_GITHUB_SETUP_USER, {
    clerkSecret: process.env.CLERK_SECRET_KEY,
    appClientId: process.env.GITHUB_APP_CLIENT_ID,
    appClientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
  });
  console.log('GitHub sign-in matches this deployment’s App. No import was started.');
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof ForgeError ? error.code : 'GITHUB_UNAVAILABLE',
      message:
        error instanceof ForgeError
          ? error.message
          : 'GitHub setup check could not complete. Credentials and provider responses withheld.',
    }),
  );
  process.exitCode = 1;
}
