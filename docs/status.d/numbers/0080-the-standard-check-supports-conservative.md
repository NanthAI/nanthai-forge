The standard check supports conservative scope selection (off unless `FORGE_CHECK_SCOPED=1` is set;
hosted Actions runs under a gate other than full set it, and audit runs set `FORGE_CHECK_FULL=1`) from a runner-pinned
View comparison, packaged Markdown-only validation, streamed test progress and
recorded scope/reason/test lists. `FORGE_CHECK_FULL=1` forces the full suite. Old
runners without pinned comparison input continue to run full. Script changes follow
static imports, literal spawning paths and package-command consumers plus smoke;
standalone scripts add exact basename tests. Check-pipeline, packaging, build and
product-runtime script dependencies retain full coverage, as do uncertain scripts
or package commands. Selection evidence records the reason.
