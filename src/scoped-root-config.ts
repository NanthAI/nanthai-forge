// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** The change-side path that sends a scoped recheck to the full suite (`scoped-root-config`): a
 * top-level file other than Markdown. A top-level `.md` is documentation (scripts/test-impact.mjs
 * `documentation`, which matches `/^[^/]+\.md$/` on a path with no folder). Pure and import-free, so
 * the keep rule (src/stale-check-keep.ts) reads the same predicate as the runner-side selection
 * (src/scoped-recheck.ts) without loading the selector. */
export const scopedRootConfig = (paths: readonly string[]) =>
  paths.find(path => !path.includes('/') && !/\.md$/.test(path));
