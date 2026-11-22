- Account, Your data offers Close your account once the account holds nothing (no projects
  outside deleted records, imports, secrets, agent grants, teams, views, watches, nothing
  shared with the person and no deletion still running). A press lists exactly what goes:
  every handle the account held, its deletion receipts, passkeys and device sign-ins. The
  person types their handle. Forge then leaves the secrets it was given and removes the
  receipts, signs out every device, waiting device code and native browser session. It
  checks the holdings again and, in one transaction, removes the passkeys, username,
  handles, handle changes, project ordering and account row. Something made mid-close keeps
  the account whole. The native user gets a fresh key, so a later GitHub sign-in starts a
  new, empty account. Deleted-project and team records stay. An account that still holds
  anything is refused with the next step. The close is retry-safe by operation id and runs
  only for the signed-in person in the browser. A close that stopped shows Continue closing.
  An operator closes a synthetic key with `accountClose:closeFor`. Old-provider (Clerk)
  sessions cannot be ended from Forge; signing in there again starts a new account on the
  old key until that provider is removed.
