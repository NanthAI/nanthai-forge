### Account identity-link audit

`authLinkEvents` holds small, secret-free identity-grant receipts: user/session,
method, operation/request digest, identity id and timestamp. The grant and audit
commit in one transaction; the `(userId, operationId)` index reconciles retries.
No provider profile, code, OAuth token or source bytes belong here. This is
account metadata, independent of projects and landings: zero bytes written per
landing, recorded in the landing storage ratchet. Normal auth component records
remain in their component. Source and artifact bodies remain in R2.
