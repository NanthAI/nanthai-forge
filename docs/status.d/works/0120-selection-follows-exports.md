- Test selection follows exports: a dependency reached inside a function only selects the
  tests that use an export reaching it; a changed file, load-time code and edges outside a
  parse stay whole ([development](../../development.md)).
