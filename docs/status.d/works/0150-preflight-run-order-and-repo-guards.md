- Preflight's protected files run fast repo-wide guard tests (ahead of the never-stopped guards:
  10 s always, up to 30 s while the later protected steps fit), guards, the change's own tests, the
  tests that load a changed module (loaders that failed before first, then whole modules, the module
  the fewest tests load first, then those one module away, while they fit; files that failed before
  get up to half of that room, so the only test of a changed module never waits behind files learned for a
  shared hub), files that failed before (the learned tier, or failed for these paths or in the last
  run here), named tests, then files by learned saving per second, smoke
  and explicit coverage last, so a long plan's time budget stops the files least likely to fail; a
  guard can get its scope from a directory walk, a relative glob, a callback that reads a list
  of paths, or the file list in a package manifest. When part of the path is computed, the
  selector can keep its known containing folder ([pre-queue checks](../../pre-queue-checks.md)).
- Changes to packaged runtime inputs run the MCP/CLI module and chunk ceilings on preflight's
  existing core build. Changes to any packaged file trigger the installed-byte check. It uses matching
  local package-smoke evidence for exact installed bytes and a lower bound on a cold run. Full archive,
  installation and CPU checks run at landing ([preflight](../../parallel-work-defaults.md#preflight)).
