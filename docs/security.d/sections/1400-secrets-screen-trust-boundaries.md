### Secrets screen trust boundaries

The route inherits the signed-in project frame. Its current provider is a local
unavailable stub, with zero Convex calls, DB I/O, storage writes or idle work.
Fixtures are confined to tests. A later server adapter must authorize current
project write access before returning names, holders or history, including on a
public project; browser state is not authorization. It must project only the
metadata contract, never values, envelopes, ciphertext or keys. Failed reads must
not render raw server errors, retain another project's data or preserve names
after access is revoked. The screen's forbidden state renders no cached metadata.

Metadata is untrusted text: React escapes displayed strings, never renders it as
HTML, and clipboard actions construct quoted name-only commands without executing
them. The clipboard is an explicit user-action boundary. No secret metadata is
written to local storage, logs, receipts or a URL. This screen is not evidence of
the future database/backup no-value guard, cryptographic revocation, hostile-server
protection, output masking or the export/retirement sequence. Those need the gated
protocol, its adversarial tests and security review before they can be claimed.
