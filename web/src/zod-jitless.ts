// SPDX-License-Identifier: Apache-2.0

// The enforced Content-Security-Policy has no 'unsafe-eval' (netlify.toml, review S-13). On its first
// parse Zod probes `Function('')` to decide whether to compile fast parsers, and the browser reports that
// probe as a CSP violation on every page. Jitless mode skips the probe and the generated code; parsing is
// unchanged. Zod reads this global config object when it loads (zod/v4/core), so setting it here keeps
// Zod out of the first-load bundle. main.tsx imports this module first; tests/web-headers.test.mjs checks
// that the pinned Zod still honours it.
const scope = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
scope.__zod_globalConfig = { ...scope.__zod_globalConfig, jitless: true };

export {};
