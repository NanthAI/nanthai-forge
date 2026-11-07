// SPDX-License-Identifier: Apache-2.0
// Throwaway forced stall for the live alert check. This Lane must never land on main.
import test from 'node:test';

test('forced stall: stays silent on CI so the landing check goes quiet', async () => {
  if (process.env.GITHUB_ACTIONS) await new Promise(resolve => setTimeout(resolve, 20 * 60_000));
});
