## Attaching account sign-in methods

The Devices screen reads display metadata from the account index in 20-key
pages. It automatically reads another page when more keys are present.
Each granting mutation checks the caller's issuer, account and session proof. Existing passkeys
confirm additions. A live Convex Auth session can attach GitHub after passkey
confirmation when present and the library's completed state/PKCE round trip.
Only the provider-attested numeric id is used. App and component identity
ownership are checked transactionally; conflicting accounts are never merged.
Successful grants and their secret-free audit receipts commit together. Retry
receipts prevent duplicate grants; GitHub tickets remain single-use.

Sign-in accepts only Convex Auth sessions and Forge CLI credentials; a token from
any other issuer is signed out, so no old-provider account can act as a Forge
account. See [Convex Auth](../../development.md#convex-auth) for setup and the
browser lifecycle rules.
