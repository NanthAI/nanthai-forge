Saves refuse credentials, and owners can purge a leaked save. A save, `land
--save` included, runs the landing secret scanner on its changed files before
any upload. A finding refuses it with `SECRET_FOUND` and stores nothing. The
scan adds no Convex call. If a credential the scanner missed reached a save, the
project owner can open that file on the Lane page and use **Purge saved
bytes…**. It deletes
the stored bytes, reads of them return `PURGED`, and the Lane's thread on the web
keeps a tombstone (what, when, who; `lane-history` does not carry it). See docs/security.d/sections/0510-secret-scan-at-save-and-owner-purge.md.
