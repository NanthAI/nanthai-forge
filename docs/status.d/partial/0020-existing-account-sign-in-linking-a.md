- **Convex Auth sign-in.** Sign-in is Convex Auth 2.0.0 only: passkeys on the
  current Forge handle and GitHub, with session-to-account guards, verified-email
  callbacks and the existing Forge CLI credential issuer. A token from any other
  issuer is signed out. Passkey sign-in validates the handle on the server, claims
  it transactionally at registration and follows later handle changes. Passkey
  starts and sign-up finish attempts have bounded global and per-handle server
  budgets; phase 8 admission policy remains undecided. A passkey account can attach
  GitHub by its completed numeric-id OAuth proof, with passkey confirmation; identity
  conflicts fail atomically and successful links are audited. GitHub App user tokens
  are encrypted in the account row with a separate service keyring. GitHub settings
  are optional for deployment and required when starting that sign-in method.
  Browser dormancy holds (`withRefreshHold` and `WhileAwake`) keep idle cost at
  zero, and `scripts/selfhost-smoke.mjs` verifies passkey sign-up/sign-in,
  refresh rotation, negative checks and revocation end to end on a self-hosted
  backend. Public-beta phone/new-user checks, admission policy and production
  setup live in Phase 8. See
  [setup and browser lifecycle rules](../../development.md#convex-auth).
