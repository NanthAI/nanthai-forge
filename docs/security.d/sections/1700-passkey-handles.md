## Passkey handles

The current Forge handle is the passkey sign-in name. The server applies the
same handle syntax and reserved destinations as account settings. A successful
registration claims its chosen handle in the same transaction, and an existing
Forge handle cannot register a second account. Existing accounts can add a
first passkey under their own handle. Changing a handle also changes its passkey
sign-in name; old URL aliases stay reserved and do not sign in. Identifier-first
sign-in retains the existing handle availability responses; it returns no
additional account profile or provider information.
