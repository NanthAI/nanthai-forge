### Secrets screen trust boundaries

The route inherits the signed-in project frame. Its names-only overview checks
current project write access, including on a public project. It returns secret
names, holders, proposal and rotation metadata, and recent changes. Values,
envelopes, ciphertext and keys stay out of the browser. Opening, refreshing or
paging the overview makes one bounded query. An idle page makes no calls or writes.

Metadata is untrusted text: React escapes displayed strings, never renders it as
HTML, and clipboard actions construct quoted name-only commands without executing
them. The clipboard is an explicit user-action boundary. No secret metadata is
written to local storage, logs, receipts or a URL. See the [setup guide](../../guides/secrets.md)
for the terminal commands that change values, approve proposals or remove a holder.
