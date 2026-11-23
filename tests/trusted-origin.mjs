// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readAuth, writeAuth, deploymentUrl } from '../dist/auth-store.js';
/** A synthetic client fixture explicitly configures its trusted origin, as a real saved login does.
 * Test runtime supplies a private configuration directory; writeAuth refuses the real account path. */
export function testDeploymentOrigin(url) {
  const origin = deploymentUrl(url),
    store = readAuth();
  store.deployments[origin] ??= {
    token: 'synthetic-fixture-token',
    credentialId: 'synthetic-fixture-device',
    expiresAt: Date.now() + 600000,
    name: 'Synthetic test',
    scope: 'cli',
  };
  writeAuth(store);
  return url;
}
