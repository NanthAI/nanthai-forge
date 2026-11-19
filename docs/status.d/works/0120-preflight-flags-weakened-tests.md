- Preflight and `land --save` flag a changed existing test that got weaker (removed or loosened
  assertions, added skips or name filters, a removed test; a changed input under the same
  assertions as a hint), by file and test name, locally and without a server call. A flag never
  fails the Lane; a `Weakened-tests: <why>` line in the landing message clears it
  ([preflight](../../parallel-work-defaults.md#preflight)).
