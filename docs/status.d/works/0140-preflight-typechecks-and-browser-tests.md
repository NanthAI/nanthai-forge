- Preflight typechecks what the landing check typechecks and runs browser tests
  with the agent's own browser: each compiler step of the project's `typecheck`
  script is its own static check, run only when its program holds a changed file
  (no typecheck for a docs-only change), and a selected browser test that skips
  or has no browser installed makes preflight NOT COMPLETE, never a pass
  ([agent workflow](../../agents/workflow.d/sections/3150-preflight-typechecks-and-browser-tests.md)).
- Local preflight shares one [heavy slot](../../parallel-work-defaults.md#localheavyslots) across
  static checks, build and tests, including runs that only execute static checks.
  Standalone preflight replans against working files edited during a slot wait.
