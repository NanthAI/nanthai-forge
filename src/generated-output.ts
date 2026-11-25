// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

/** Convex codegen output (convex/_generated/ and each component's _generated/): a local dev push or codegen
 * rewrites it, it is regenerated on every run and never hand-edited, so it is not a local edit that blocks a
 * pull or lists as one (friction 9367f1b7). A pull that changes such a file replaces it. */
export const generatedOutput = (path: string) => /^convex\/(?:.+\/)?_generated\//.test(path);
