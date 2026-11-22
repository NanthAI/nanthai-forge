## Secret Objects

A Secret Object is an encrypted credential with versions and six independent capabilities: discover, names, use, reveal, modify and delegate.

- Versions are sealed with AES-256-GCM under the keyring in `FORGE_SECRET_KEYS`.
- The only broker operation reads one fixed GitHub repository and ref. It rejects redirects and returns only the commit SHA, version and time. Policy and version are rechecked after the provider call.
- Checks, Playbooks and repository code never receive a stored secret.
- Delegated grants depend on the current authority of every issuing delegate in their chain. Revoking a delegate also revokes their transitive grants; expiry invalidates the chain immediately, before scheduled cleanup. Re-granting access does not restore revoked descendants; restoring them requires new explicit grants. Revocation confirmation previews the affected recipients and capabilities, pinned to the policy revision; cascaded removals are audited without values.
- Successful use, reveal and configuration changes are audited without the value. Denied and failed attempts are not stored.
- Backend administrators, the keyring owner, the OS and GitHub stay trusted.
- Recovery needs the original keys. Losing an old key makes its versions unreadable.

Devices need write access to all projects to create, rotate, grant, disable or
move a Secret Object to trash. Permanent deletion requires the owner person in a
Forge browser. Existing object capabilities still govern each operation.

Dotenv import creates a Secret Object and a value-free example file. It does not erase committed history or rotate the provider's credential. Rotate an exposed credential at GitHub first.
