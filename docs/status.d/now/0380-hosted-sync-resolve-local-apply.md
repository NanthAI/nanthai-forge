Hosted sync/resolve local apply preserves ignored build output and dependency
links using project ignore rules and Forge source exclusions. Saved source and
incoming path collisions remain protected; interrupted artifact moves resume with
the original apply operation. Relative checkout roots use a canonical sibling
client cache. A sync/resolve apply onto an installed checkout installs only the
changed paths in place, under a crash-safe journal (a one-file apply on a
synthetic 29,000-file checkout: 9 hashes and 1 clone instead of 116,004 and
29,000). Save, abandon, preflight and every other command that trusts the
checkout marker finish or roll back an interrupted apply first, so a crash
mid-apply never turns upstream bytes into local edits. The clean check still
stats every materialized path, like Git.
