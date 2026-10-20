# Design constraints

These rules hold the design together. Break one only with an explicit owner decision.

1. **Standalone.** Forge does not depend on NanthAI:Edge accounts, deployment or runtime.
2. **Source and Work are separate.** Immutable source and analysis stay apart from changing Work and current authorization. Old pins and grants never give new access.
3. **One owner per fact.** The existing source, Work, persistence and authorization owners stay authoritative. Do not add a competing store in a client cache, worker spool or adapter. Before adding a cache, table or journal, name the owner it would duplicate.
4. **Mutations are idempotent.** Every mutation carries a client UUID. After an unknown outcome, replay the same UUID and payload. It returns the original result, never reruns a command and never rewinds a later Channel. A changed payload needs a new UUID. Channel acceptance names the expected previous head.
5. **Pins are exact.** A Candidate or run pins its source, definition and environment. A stale pin fails before any work starts. Later changes never alter a recorded result.
6. **Parsing never executes code.** Checks and agents run locally under the OS account. Managed execution and secret use by arbitrary code do not exist.
7. **Native is the daily format.** Git import, export and publication are explicit compatibility boundaries. Existing Git-backed owners stay supported.
8. **Unknown stays unknown.** Missing analysis edges, unmodelled languages and unreported coverage are never proof of independence. Do not guess a binding or fall back to an outer scope.
9. **History is kept.** No automatic age or count deletion, no quotas and no retention deadlines unless the owner asks. Collection removes only verified unreferenced objects.
10. **Live signals are advisory.** Sessions and messages are never locks, never authorization and never acceptance. Declared readiness is not checked or accepted source.
11. **No sandbox claims.** Do not describe Lanes, worktrees, MCP permissions or scoped grants as confinement.
12. **Hosted stack is fixed for development.** Convex storage, Clerk identity, the Forge GitHub App and Netlify hosting. Optional self-host does not move the development deployment to S3. PostHog is deferred.
13. **No new restrictions without being asked.** Do not add user-facing limits, extra steps, delays, access conditions or retention rules. A review finding does not authorize them.
