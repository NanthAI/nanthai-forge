- Preflight and `land --save` flag a changed existing test that got weaker (removed or loosened
  assertions, added skips or name filters, or a removed test), by file and test name, locally and
  without a server call. Calls to file and suite helpers contribute their own assertions. An early
  bare `return` before assertions is a skip. A changed input or `test.each` table is a hint. A flag never
  fails the Lane; a `Weakened-tests: <why>` line in the landing message clears it
  ([preflight](../../parallel-work-defaults.md#preflight)).
