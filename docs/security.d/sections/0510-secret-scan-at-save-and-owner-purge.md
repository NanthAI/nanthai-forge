## Secret scan at save and owner purge

On a public project any signed-in person can read a saved Lane, so a credential has to be stopped before the save stores it. A save, `land --save` included, runs the [landing scanner](0500-secret-scan-at-landing.md) on its changed files after capture and before any upload. It uses the same patterns, the same 1 MiB file bound and the same allow entries: those in `.forge-secret-allow.json` on the Lane's base (main) State, never the Lane's own edit of that file. A finding refuses the save with `SECRET_FOUND`. Nothing is uploaded, no save row is written and the staged capture is dropped. The reply names path, line, kind and fingerprint, never the value. It also carries the exact allow entry for a false positive, and in `next` and `command` the same save to run once the file is fixed. The CLI and MCP replies are the same object. Cost: no Convex call or network I/O. CPU grows with the changed bytes (about 13 to 20 MB/s on a laptop; a 10-file save adds about 5 ms). The scan reads one State manifest and one allow file from this machine's object store. Idle cost is nothing.

If a credential the scanner does not know still reached a save, the project owner can purge it. On the Lane page, an opened changed file shows **Purge saved bytes…** to the owner only, and only before the Lane lands. The owner types PURGE (`projectSavePurge:purge`; browser only, never a device credential). The purge compares the Lane head with the Lane's base, or one save's head with the State it was saved over. The server checks the selection:

- It refuses a path that comparison did not change, a link, an empty file, and bytes that current main holds at any path. A landed leak needs its history rewritten, not a save purge.
- It refuses a large file stored in chunks. Purge covers files stored whole.
- It refuses if main moved while it checked, or if another purge in the project is still deleting bytes.

Then, in one transaction, it:

- marks each object row purged;
- drops the Lane's built Git commit;
- schedules the Lane snapshot purge;
- writes the receipt (`projectSavePurges`, one row per operation id);
- writes a tombstone message in the Lane's thread that says what was purged, when and by whom.

From that moment every read through the single object lookup returns `PURGED`, naming when and by which purge: checkout, diff, show, Git Lane fetches, compose and the GitHub mirror. Catalog compaction keeps the purged row. A Git build that started before the purge is not cached.

A State's physical manifest maps files straight to stored bytes, past that lookup. Once a project has a purge, checkouts, check runners and source grants stop using physical manifests and read through the catalog path instead. That costs one indexed read per such request, and reads in that project get a little slower.

After the mark, the action deletes the raw R2 objects and the Git commit chunks. It zeroes a packed member's byte range in its upload pack; the rewrite carries If-Match on the ETag it read, and the pack's other members still verify by their own digests. Then it marks the receipt done. A retry with the same operation id returns the same receipt and finishes any R2 work left. The same id with another selection is refused.

Limits: copies already downloaded to a machine, a CI log or a fork stay where they are, so always rotate the credential. The purge removes the bytes, not the State that names them. A later save of the Lane that still holds the file cannot be read either, so save it without that file. The same bytes in another Lane are purged too (one object), but only this Lane's Git commit and snapshots are dropped. Landing trial merges and source workers that read a physical manifest fail on the zeroed bytes instead of naming PURGED.
