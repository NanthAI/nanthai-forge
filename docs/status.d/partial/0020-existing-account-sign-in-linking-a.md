- **Existing-account sign-in linking.** A retained provider session can enroll
  a passkey on its exact Forge account; the methods screen attaches GitHub by
  its completed numeric-id OAuth proof, with passkey confirmation when present.
  Identity conflicts fail atomically and successful links are audited. Non-provider
  agent/bot keys retain CLI access and are excluded from browser migration;
  owner review of unmatched accounts and long-term renewal remains open before
  Clerk removal. No live account linking is implied by deployment.
- **Convex Auth foundation.** The server offers Convex Auth 2.0.0 GitHub/passkey
  methods beside Clerk, with session-to-account guards, verified-email callbacks,
  first-passkey glue and the existing Forge CLI credential issuer. Passkey
  sign-in uses the current Forge handle, validates it on the server, claims it
  transactionally at registration and follows later handle changes. Passkey
  starts and sign-up finish attempts have bounded global and per-handle
  server budgets; phase 8 admission policy remains undecided. GitHub App user
  tokens are encrypted in the new account row with a separate service keyring.
  An operator backfill preserves existing Forge keys using verified numeric
  GitHub ids, with bounded pages, dry runs, safe resume and typed conflict refusal.
  GitHub settings are optional for deployment and required when starting that
  sign-in method. The web UI still uses Clerk.
  Live GitHub, real phones, deployed account-mapping evidence, browser
  dormancy integration and the pre-removal security review remain open. See
  [setup and browser lifecycle rules](../../development.md#convex-auth-core-beside-clerk).
