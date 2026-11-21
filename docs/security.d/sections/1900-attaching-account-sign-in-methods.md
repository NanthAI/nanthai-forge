## Attaching account sign-in methods

An existing-provider session can enroll a passkey on that exact Forge account.
The Devices screen reads display metadata from the account index in 20-key
pages. It automatically reads another page when more keys are present.
Each action verifies the session is active with its provider; each granting
mutation checks the caller's issuer, account and session proof. Existing passkeys
confirm additions. A live Convex Auth session can attach GitHub after passkey
confirmation when present and the library's completed state/PKCE round trip.
Only the provider-attested numeric id is used. App and component identity
ownership are checked transactionally; conflicting accounts are never merged.
Successful grants and their secret-free audit receipts commit together. Retry
receipts prevent duplicate grants; GitHub tickets remain single-use.

These browser flows do not establish ownership of non-provider agent/bot keys.
Existing CLI access remains; long-term renewal and the deliberately unmatched
accounts need owner review before removal. Clerk remains configured. See
[the linking runbook](../../development.md#attach-sign-in-methods-to-an-existing-account)
for proof boundaries, retries, scale and the migration exclusion.
